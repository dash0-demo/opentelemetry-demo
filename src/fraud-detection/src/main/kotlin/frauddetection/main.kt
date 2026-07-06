/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

package frauddetection

import io.opentelemetry.api.GlobalOpenTelemetry
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.metrics.LongCounter
import io.opentelemetry.api.trace.Span
import io.opentelemetry.api.trace.SpanKind
import io.opentelemetry.api.trace.StatusCode
import io.opentelemetry.context.Context
import io.opentelemetry.context.propagation.TextMapGetter
import io.opentelemetry.exporter.otlp.logs.OtlpGrpcLogRecordExporter
import io.opentelemetry.exporter.otlp.metrics.OtlpGrpcMetricExporter
import io.opentelemetry.exporter.otlp.trace.OtlpGrpcSpanExporter
import io.opentelemetry.instrumentation.log4j.appender.v2_17.OpenTelemetryAppender
import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.logs.SdkLoggerProvider
import io.opentelemetry.sdk.logs.export.BatchLogRecordProcessor
import io.opentelemetry.sdk.metrics.SdkMeterProvider
import io.opentelemetry.sdk.metrics.export.PeriodicMetricReader
import io.opentelemetry.sdk.resources.Resource
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor
import io.opentelemetry.semconv.ServiceAttributes
import org.apache.kafka.clients.consumer.ConsumerConfig.*
import org.apache.kafka.clients.consumer.ConsumerRecord
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.header.Headers
import org.apache.kafka.common.serialization.ByteArrayDeserializer
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.logging.log4j.LogManager
import org.apache.logging.log4j.Logger
import oteldemo.Demo.*
import java.time.Duration.ofMillis
import java.util.*
import kotlin.system.exitProcess
import dev.openfeature.contrib.providers.flagd.FlagdOptions
import dev.openfeature.contrib.providers.flagd.FlagdProvider
import dev.openfeature.sdk.ImmutableContext
import dev.openfeature.sdk.Value
import dev.openfeature.sdk.OpenFeatureAPI

const val topic = "orders"
const val groupID = "fraud-detection"

private val logger: Logger = LogManager.getLogger(groupID)

/** TextMapGetter that reads propagation headers from Kafka record headers. */
object KafkaHeadersGetter : TextMapGetter<Headers> {
    override fun keys(carrier: Headers): Iterable<String> =
        carrier.map { it.key() }

    override fun get(carrier: Headers?, key: String): String? =
        carrier?.lastHeader(key)?.value()?.let { String(it, Charsets.UTF_8) }
}

/** Initialise the OpenTelemetry SDK and register it as the global instance. */
fun initOpenTelemetry(): OpenTelemetrySdk {
    val resource = Resource.getDefault().merge(
        Resource.create(
            Attributes.of(
                ServiceAttributes.SERVICE_NAME, "fraud-detection",
                ServiceAttributes.SERVICE_VERSION,
                System.getenv("VERSION") ?: "unknown"
            )
        )
    )

    val traceExporter = OtlpGrpcSpanExporter.getDefault()
    val tracerProvider = SdkTracerProvider.builder()
        .addSpanProcessor(BatchSpanProcessor.builder(traceExporter).build())
        .setResource(resource)
        .build()

    val metricExporter = OtlpGrpcMetricExporter.getDefault()
    val meterProvider = SdkMeterProvider.builder()
        .registerMetricReader(PeriodicMetricReader.builder(metricExporter).build())
        .setResource(resource)
        .build()

    val logExporter = OtlpGrpcLogRecordExporter.getDefault()
    val loggerProvider = SdkLoggerProvider.builder()
        .addLogRecordProcessor(BatchLogRecordProcessor.builder(logExporter).build())
        .setResource(resource)
        .build()

    val sdk = OpenTelemetrySdk.builder()
        .setTracerProvider(tracerProvider)
        .setMeterProvider(meterProvider)
        .setLoggerProvider(loggerProvider)
        .setPropagators(
            io.opentelemetry.context.propagation.ContextPropagators.create(
                io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator.getInstance()
            )
        )
        .buildAndRegisterGlobal()

    // Wire the Log4j2 OTel appender to the SDK logger provider so that
    // log4j log records are exported as OTLP log records.
    OpenTelemetryAppender.install(sdk)

    return sdk
}

fun main() {
    val sdk = initOpenTelemetry()
    val tracer = sdk.getTracer("fraud-detection")
    val meter = sdk.getMeter("fraud-detection")

    val ordersProcessedCounter: LongCounter = meter.counterBuilder("app.fraud_detection.orders_processed")
        .setDescription("Total number of orders inspected for fraud")
        .setUnit("{order}")
        .build()
    val fraudDetectedCounter: LongCounter = meter.counterBuilder("app.fraud_detection.fraud_detected")
        .setDescription("Number of orders flagged as potentially fraudulent")
        .setUnit("{order}")
        .build()

    val options = FlagdOptions.builder()
        .withGlobalTelemetry(true)
        .build()
    val flagdProvider = FlagdProvider(options)
    OpenFeatureAPI.getInstance().setProvider(flagdProvider)

    val props = Properties()
    props[KEY_DESERIALIZER_CLASS_CONFIG] = StringDeserializer::class.java.name
    props[VALUE_DESERIALIZER_CLASS_CONFIG] = ByteArrayDeserializer::class.java.name
    props[GROUP_ID_CONFIG] = groupID
    // Read from the start of the topic so a freshly-joined consumer group still
    // processes orders produced before it finished joining, matching the
    // accounting consumer's behaviour. Without this the Kafka default of
    // "latest" silently drops those orders, so fraud-detection may emit no
    // telemetry on a quiet/cold start.
    props[AUTO_OFFSET_RESET_CONFIG] = "earliest"
    val bootstrapServers = System.getenv("KAFKA_ADDR")
    if (bootstrapServers == null) {
        println("KAFKA_ADDR is not supplied")
        exitProcess(1)
    }
    props[BOOTSTRAP_SERVERS_CONFIG] = bootstrapServers
    val consumer = KafkaConsumer<String, ByteArray>(props).apply {
        subscribe(listOf(topic))
    }

    var totalCount = 0L

    consumer.use {
        while (true) {
            totalCount = consumer
                .poll(ofMillis(100))
                .fold(totalCount) { accumulator, record ->
                    val newCount = accumulator + 1

                    if (getFeatureFlagValue("kafkaQueueProblems") > 0) {
                        logger.info("FeatureFlag 'kafkaQueueProblems' is enabled, sleeping 1 second")
                        Thread.sleep(1000)
                    }

                    processRecord(
                        record, tracer, ordersProcessedCounter, fraudDetectedCounter, newCount
                    )
                    newCount
                }
        }
    }

    sdk.shutdown()
}

/**
 * Processes a single Kafka record:
 * - Extracts upstream trace context from record headers.
 * - Creates a consumer span as a child of the upstream checkout span.
 * - Parses the order, increments counters, and flags high-value orders.
 */
private fun processRecord(
    record: ConsumerRecord<String, ByteArray>,
    tracer: io.opentelemetry.api.trace.Tracer,
    ordersProcessedCounter: LongCounter,
    fraudDetectedCounter: LongCounter,
    totalCount: Long
) {
    // Extract upstream W3C trace context from Kafka record headers.
    val propagator = GlobalOpenTelemetry.getPropagators().textMapPropagator
    val parentContext = propagator.extract(Context.current(), record.headers(), KafkaHeadersGetter)

    val span = tracer.spanBuilder("orders process")
        .setParent(parentContext)
        .setSpanKind(SpanKind.CONSUMER)
        .setAttribute("messaging.system", "kafka")
        .setAttribute("messaging.destination.name", topic)
        .setAttribute("messaging.operation", "process")
        .setAttribute(AttributeKey.longKey("messaging.kafka.message.offset"), record.offset())
        .startSpan()

    span.makeCurrent().use {
        try {
            val order = OrderResult.parseFrom(record.value())
            logger.info(
                "Consumed record with orderId: ${order.orderId}, and updated total count to: $totalCount"
            )

            span.setAttribute("app.order.id", order.orderId)
            span.setAttribute(
                AttributeKey.longKey("app.order.items.count"),
                order.itemsCount.toLong()
            )

            ordersProcessedCounter.add(1, Attributes.of(AttributeKey.stringKey("messaging.system"), "kafka"))

            // Simple heuristic: flag orders whose item count is unusually high.
            val isSuspicious = order.itemsCount > 10
            span.setAttribute("app.fraud_detection.suspicious", isSuspicious)

            if (isSuspicious) {
                fraudDetectedCounter.add(
                    1,
                    Attributes.of(AttributeKey.stringKey("app.order.id"), order.orderId)
                )
                logger.warn("Suspicious order detected: orderId=${order.orderId}, itemCount=${order.itemsCount}")
            }

            span.setStatus(StatusCode.OK)
        } catch (e: Exception) {
            logger.error("Failed to process order record", e)
            span.recordException(e)
            span.setStatus(StatusCode.ERROR, e.message ?: "processing failed")
        } finally {
            span.end()
        }
    }
}

/**
 * Retrieves the status of a feature flag from the Feature Flag service.
 *
 * @param ff The name of the feature flag to retrieve.
 * @return `true` if the feature flag is enabled, `false` otherwise or in case of errors.
 */
fun getFeatureFlagValue(ff: String): Int {
    val client = OpenFeatureAPI.getInstance().client
    // TODO: Plumb the actual session ID from the frontend via baggage?
    val uuid = UUID.randomUUID()

    val clientAttrs = mutableMapOf<String, Value>()
    clientAttrs["session"] = Value(uuid.toString())
    client.evaluationContext = ImmutableContext(clientAttrs)
    val intValue = client.getIntegerValue(ff, 0)
    return intValue
}
