# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

require "ostruct"
require "pony"
require "sinatra"
require "open_feature/sdk"
require "openfeature/flagd/provider"

require "opentelemetry/sdk"
require "opentelemetry-logs-sdk"
require "opentelemetry-metrics-sdk"
require "opentelemetry/exporter/otlp"
require "opentelemetry-exporter-otlp-logs"
require "opentelemetry-exporter-otlp-metrics"
require "opentelemetry/instrumentation/sinatra"

set :port, ENV["EMAIL_PORT"]

# Initialize OpenFeature SDK with flagd provider
flagd_client = OpenFeature::Flagd::Provider.build_client
flagd_client.configure do |config|
  config.host = ENV.fetch("FLAGD_HOST", "localhost")
  config.port = ENV.fetch("FLAGD_PORT", 8013).to_i
  config.tls = ENV.fetch("FLAGD_TLS", "false") == "true"
end

OpenFeature::SDK.configure do |config|
  config.set_provider(flagd_client)
end

OpenTelemetry::SDK.configure do |c|
  c.use "OpenTelemetry::Instrumentation::Sinatra"
end

$logger = OpenTelemetry.logger_provider.logger(name: 'email')

# Build the OpenFeature client once instead of per request
$flag_client = OpenFeature::SDK.build_client

otlp_metric_exporter = OpenTelemetry::Exporter::OTLP::Metrics::MetricsExporter.new
OpenTelemetry.meter_provider.add_metric_reader(otlp_metric_exporter)
meter = OpenTelemetry.meter_provider.meter("email")
$confirmation_counter = meter.create_counter("demo.notification.confirmations", unit: "1", description: "Counts the number of order confirmation emails sent")
# Makes the emailMemoryLeak scenario attributable from telemetry alone: without these,
# growing container memory cannot be told apart from an unintentional leak.
$retained_bytes_counter = meter.create_counter("demo.email.retained_delivery_bytes", unit: "By", description: "Bytes of email bodies deliberately retained in the test mailer by the emailMemoryLeak feature flag")
$retained_deliveries_counter = meter.create_counter("demo.email.retained_deliveries", unit: "1", description: "Number of email deliveries deliberately retained in the test mailer by the emailMemoryLeak feature flag")

post "/send_order_confirmation" do
  data = JSON.parse(request.body.read, object_class: OpenStruct)

  # get the current auto-instrumented span
  current_span = OpenTelemetry::Trace.current_span
  current_span.add_attributes({
    "demo.order.id" => data.order.order_id,
  })

  $confirmation_counter.add(1)
  send_email(data)

end

error do
  OpenTelemetry::Trace.current_span.record_exception(env['sinatra.error'])
end

def send_email(data)
  # create and start a manual span
  tracer = OpenTelemetry.tracer_provider.tracer('email')
  tracer.in_span("send_email") do |span|
    # Check if memory leak flag is enabled
    memory_leak_multiplier = $flag_client.fetch_number_value(flag_key: "emailMemoryLeak", default_value: 0)

    # To speed up the memory leak we create a long email body
    confirmation_content = erb(:confirmation, locals: { order: data.order })
    whitespace_length = [0, confirmation_content.length * (memory_leak_multiplier-1)].max
    body = confirmation_content + " " * whitespace_length

    Pony.mail(
      to:       data.email,
      from:     "noreply@example.com",
      subject:  "Your confirmation email",
      body:     body,
      via:      :test
    )

    # If not clearing the deliveries, the emails will accumulate in the test mailer
    # We use this to create a memory leak.
    if memory_leak_multiplier < 1
      Mail::TestMailer.deliveries.clear
    else
      # The leak is deliberate, but it has to be attributable: report how much is
      # being retained and under which flag value, so container memory growth can
      # be traced back to this scenario instead of being investigated as a defect.
      $retained_bytes_counter.add(body.bytesize, attributes: { "demo.email.memory_leak.multiplier" => memory_leak_multiplier })
      $retained_deliveries_counter.add(1, attributes: { "demo.email.memory_leak.multiplier" => memory_leak_multiplier })
    end

    span.set_attribute("demo.email.memory_leak.multiplier", memory_leak_multiplier)
    span.set_attribute("demo.email.retained_deliveries", Mail::TestMailer.deliveries.length)
    span.set_attribute("demo.order.id", data.order.order_id)
    $logger.on_emit(
      timestamp: Time.now,
      severity_text: 'INFO',
      body: 'Order confirmation email sent',
      attributes: { 'demo.order.id' => data.order.order_id },
    )

    puts "Order confirmation email sent for order #{data.order.order_id}"
  end
  # manually created spans need to be ended
  # in Ruby, the method `in_span` ends it automatically
  # check out the OpenTelemetry Ruby docs at: 
  # https://opentelemetry.io/docs/instrumentation/ruby/manual/#creating-new-spans 
end
