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
import io.opentelemetry.api.trace.Tracer
import io.opentelemetry.context.Context
import io.opentelemetry.context.propagation.TextMapGetter
import io.opentelemetry.sdk.autoconfigure.AutoConfiguredOpenTelemetrySdk
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

/**
 * A [TextMapGetter] that reads W3C trace-context / baggage headers stored in
 * Kafka [Headers] so that the OTel propagator can extract the upstream context
 * and link this consumer span to the producer trace.
 */
private object KafkaHeadersGetter : TextMapGetter<Headers> {
    override fun keys(carrier: Headers): Iterable<String> =
        carrier.map { it.key() }

    override fun get(carrier: Headers?, key: String): String? =
        carrier?.lastHeader(key)?.value()?.let { String(it, Charsets.UTF_8) }
}

fun main() {
    // ---------------------------------------------------------------------------
    // 1. Bootstrap the OTel SDK via autoconfigure.
    //    All configuration is read from OTEL_* environment variables (endpoint,
    //    service name, resource attributes, exporter protocol, etc.).
    //    AutoConfiguredOpenTelemetrySdk registers itself as the GlobalOpenTelemetry
    //    instance and sets up a shutdown hook automatically.
    // ---------------------------------------------------------------------------
    val openTelemetry = AutoConfiguredOpenTelemetrySdk.initialize().openTelemetrySdk

    val tracer: Tracer = openTelemetry.getTracer("frauddetection", "1.0.0")
    val meter = openTelemetry.getMeter("frauddetection")

    // Counter: total orders evaluated, labelled by fraud verdict.
    val ordersCounter: LongCounter = meter
        .counterBuilder("fraud_detection.orders.processed")
        .setDescription("Total number of orders evaluated by the fraud-detection service")
        .setUnit("{order}")
        .build()

    // ---------------------------------------------------------------------------
    // 2. Feature flags
    // ---------------------------------------------------------------------------
    val options = FlagdOptions.builder()
        .withGlobalTelemetry(true)
        .build()
    val flagdProvider = FlagdProvider(options)
    OpenFeatureAPI.getInstance().setProvider(flagdProvider)

    // ---------------------------------------------------------------------------
    // 3. Kafka consumer
    // ---------------------------------------------------------------------------
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
                    processRecord(record, tracer, ordersCounter, newCount)
                    newCount
                }
        }
    }
}

/**
 * Processes a single Kafka record:
 * - extracts the upstream W3C trace context from the record headers,
 * - opens a consumer span linked to that context,
 * - evaluates the order for fraud,
 * - records a metric and closes the span.
 */
private fun processRecord(
    record: ConsumerRecord<String, ByteArray>,
    tracer: Tracer,
    ordersCounter: LongCounter,
    totalCount: Long,
) {
    // Extract the upstream trace context propagated via Kafka message headers.
    val propagator = GlobalOpenTelemetry.getPropagators().textMapPropagator
    val parentContext = propagator.extract(Context.current(), record.headers(), KafkaHeadersGetter)

    // Build a CONSUMER span that is a child of (or linked to) the producer span.
    val span: Span = tracer.spanBuilder("$topic receive")
        .setSpanKind(SpanKind.CONSUMER)
        .setParent(parentContext)
        .setAttribute("messaging.system", "kafka")
        .setAttribute("messaging.operation", "receive")
        .setAttribute("messaging.destination.name", topic)
        .setAttribute("messaging.kafka.consumer.group", groupID)
        .setAttribute("messaging.kafka.partition", record.partition().toLong())
        .setAttribute("messaging.kafka.offset", record.offset())
        .startSpan()

    // Make the span active so that logs emitted inside this scope carry the
    // correct trace_id / span_id via the Log4j2 MDC integration shipped with
    // the Java agent.
    span.makeCurrent().use { _ ->
        try {
            if (getFeatureFlagValue("kafkaQueueProblems") > 0) {
                logger.info("FeatureFlag 'kafkaQueueProblems' is enabled, sleeping 1 second")
                Thread.sleep(1000)
            }

            val order = OrderResult.parseFrom(record.value())
            val orderId = order.orderId

            // Attach business-level attributes to the span.
            span.setAttribute("order.id", orderId)
            span.setAttribute("fraud_detection.total_orders_processed", totalCount)

            // Simple heuristic: flag orders whose total item count is suspiciously high.
            val totalItems = order.itemsList.sumOf { it.item.quantity }
            val isSuspicious = totalItems > 50
            val verdict = if (isSuspicious) "flagged" else "approved"

            span.setAttribute("fraud_detection.verdict", verdict)
            span.setAttribute("fraud_detection.total_items", totalItems.toLong())

            ordersCounter.add(
                1,
                Attributes.of(
                    AttributeKey.stringKey("fraud_detection.verdict"), verdict,
                    AttributeKey.stringKey("messaging.destination.name"), topic,
                ),
            )

            logger.info(
                "Consumed order orderId={} verdict={} totalItems={} totalCount={}",
                orderId, verdict, totalItems, totalCount,
            )

            span.setStatus(StatusCode.OK)
        } catch (e: Exception) {
            span.setStatus(StatusCode.ERROR, e.message ?: "processing error")
            span.recordException(e)
            logger.error("Failed to process order record", e)
        } finally {
            span.end()
        }
    }
}

/**
 * Retrieves the status of a feature flag from the Feature Flag service.
 *
 * @param ff The name of the feature flag to retrieve.
 * @return The integer value of the feature flag (0 when disabled or on error).
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
