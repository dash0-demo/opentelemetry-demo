#!/usr/bin/python

# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

import json
import os
import random
import uuid
import logging

import asyncio
import gevent

from locust import HttpUser, task, between
from locust_plugins.users import playwright as playwright_plugin
from locust_plugins.users.playwright import PlaywrightUser, pw, PageWithRetry, event

from opentelemetry import context, baggage, trace
from opentelemetry.context import Context
from opentelemetry.metrics import set_meter_provider
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.jinja2 import Jinja2Instrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor
from opentelemetry.instrumentation.system_metrics import SystemMetricsInstrumentor
from opentelemetry.instrumentation.urllib3 import URLLib3Instrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource

from openfeature import api
from openfeature.contrib.provider.ofrep import OFREPProvider
from openfeature.contrib.hook.opentelemetry import TracingHook

from playwright.async_api import Route, Request

# Configure tracer provider first (needed for trace context in logs)
tracer_provider = TracerProvider()
trace.set_tracer_provider(tracer_provider)
tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(insecure=True)))

# Configure logger provider with the same resource
logger_provider = LoggerProvider()
set_logger_provider(logger_provider)

# Set up log exporter and processor
log_exporter = OTLPLogExporter(insecure=True)
logger_provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))

# Create logging handler that will include trace context
handler = LoggingHandler(level=logging.INFO, logger_provider=logger_provider)

# Configure root logger
root_logger = logging.getLogger()
root_logger.addHandler(handler)
root_logger.setLevel(logging.INFO)

# Configure metrics
metric_exporter = OTLPMetricExporter(insecure=True)
set_meter_provider(MeterProvider([PeriodicExportingMetricReader(metric_exporter)]))

# Instrument logging to automatically inject trace context
LoggingInstrumentor().instrument(set_logging_format=True)

# Instrumenting manually to avoid error with locust gevent monkey
Jinja2Instrumentor().instrument()
RequestsInstrumentor().instrument()
SystemMetricsInstrumentor().instrument()
URLLib3Instrumentor().instrument()

logging.info("Instrumentation complete - logs will now include trace context")

# Initialize Flagd provider
base_url = f"http://{os.environ.get('FLAGD_HOST', 'localhost')}:{os.environ.get('FLAGD_OFREP_PORT', 8016)}"
api.set_provider(OFREPProvider(base_url=base_url))
api.add_hooks([TracingHook()])

def get_flagd_value(FlagName):
    # Initialize OpenFeature
    client = api.get_client()
    return client.get_integer_value(FlagName, 0)

categories = [
    "binoculars",
    "telescopes",
    "accessories",
    "assembly",
    "travel",
    "books",
    None,
]

products = [
    "0PUK6V6EV0",
    "1YMWWN1N4O",
    "2ZYFJ3GM2N",
    "66VCHSJNUP",
    "6E92ZMYYFZ",
    "9SIQT8TOJO",
    "L9ECAV7KIM",
    "LS4PSXUNUM",
    "OLJCESPC7Z",
    "HQTGWGPNH4",
]

people_file = open('people.json')
people = json.load(people_file)

class WebsiteUser(HttpUser):
    wait_time = between(1, 10)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.tracer = trace.get_tracer(__name__)

    @task(1)
    def index(self):
        with self.tracer.start_as_current_span("user_index", context=Context()):
            logging.info("User accessing index page")
            self.client.get("/")

    @task(10)
    def browse_product(self):
        product = random.choice(products)
        with self.tracer.start_as_current_span("user_browse_product", context=Context(), attributes={"product.id": product}):
            logging.info(f"User browsing product: {product}")
            self.client.get("/api/products/" + product)

    @task(3)
    def get_recommendations(self):
        product = random.choice(products)
        with self.tracer.start_as_current_span("user_get_recommendations", context=Context(), attributes={"product.id": product}):
            logging.info(f"User getting recommendations for product: {product}")
            params = {
                "productIds": [product],
            }
            self.client.get("/api/recommendations", params=params)

    @task(3)
    def get_ads(self):
        category = random.choice(categories)
        with self.tracer.start_as_current_span("user_get_ads", context=Context(), attributes={"category": str(category)}):
            logging.info(f"User getting ads for category: {category}")
            params = {
                "contextKeys": [category],
            }
            self.client.get("/api/data/", params=params)

    @task(3)
    def view_cart(self):
        with self.tracer.start_as_current_span("user_view_cart", context=Context()):
            logging.info("User viewing cart")
            self.client.get("/api/cart")

    @task(2)
    def add_to_cart(self, user=""):
        if user == "":
            user = str(uuid.uuid1())
        product = random.choice(products)
        quantity = random.choice([1, 2, 3, 4, 5, 10])
        with self.tracer.start_as_current_span("user_add_to_cart", context=Context(), attributes={"user.id": user, "product.id": product, "quantity": quantity}):
            logging.info(f"User {user} adding {quantity} of product {product} to cart")
            self.client.get("/api/products/" + product)
            cart_item = {
                "item": {
                    "productId": product,
                    "quantity": quantity,
                },
                "userId": user,
            }
            self.client.post("/api/cart", json=cart_item)

    @task(1)
    def checkout(self):
        user = str(uuid.uuid1())
        with self.tracer.start_as_current_span("user_checkout_single", context=Context(), attributes={"user.id": user}):
            self.add_to_cart(user=user)
            checkout_person = random.choice(people)
            checkout_person["userId"] = user
            self.client.post("/api/checkout", json=checkout_person)
            logging.info(f"Checkout completed for user {user}")

    @task(1)
    def checkout_multi(self):
        user = str(uuid.uuid1())
        item_count = random.choice([2, 3, 4])
        with self.tracer.start_as_current_span("user_checkout_multi", context=Context(),
                                            attributes={"user.id": user, "item.count": item_count}):
            for i in range(item_count):
                self.add_to_cart(user=user)
            checkout_person = random.choice(people)
            checkout_person["userId"] = user
            self.client.post("/api/checkout", json=checkout_person)
            logging.info(f"Multi-item checkout completed for user {user}")

    @task(5)
    def flood_home(self):
        flood_count = get_flagd_value("loadGeneratorFloodHomepage")
        if flood_count > 0:
            with self.tracer.start_as_current_span("user_flood_home",  context=Context(), attributes={"flood.count": flood_count}):
                logging.info(f"User flooding homepage {flood_count} times")
                for _ in range(0, flood_count):
                    self.client.get("/")

    def on_start(self):
        with self.tracer.start_as_current_span("user_session_start", context=Context()):
            session_id = str(uuid.uuid4())
            logging.info(f"Starting user session: {session_id}")
            ctx = baggage.set_baggage("session.id", session_id)
            ctx = baggage.set_baggage("synthetic_request", "true", context=ctx)
            context.attach(ctx)
            self.index()


browser_traffic_enabled = os.environ.get("LOCUST_BROWSER_TRAFFIC_ENABLED", "").lower() in ("true", "yes", "on")

if browser_traffic_enabled:
    class WebsiteBrowserUser(PlaywrightUser):
        headless = True  # to use a headless browser, without a GUI

        # PlaywrightUser launches one Chromium in its constructor and never closes it,
        # so the browser process lives as long as the load generator itself. Every task
        # opens and closes a fresh BrowserContext, but the browser process keeps the
        # memory and the on-disk profile cache that those contexts leave behind, so its
        # footprint grows for as long as the process runs. Recycling the browser every
        # N tasks bounds that growth; the Playwright driver is reused, so the cost is a
        # browser launch every N iterations.
        browser_recycle_after_tasks = int(os.environ.get("LOCUST_BROWSER_RECYCLE_AFTER_TASKS", "200"))

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            # A list, so the shallow sub-user copies PlaywrightUser makes share the count.
            self.browser_task_count = [0]
            for sub_user in self.sub_users:
                sub_user.browser_task_count = self.browser_task_count

        async def recycle_browser_if_needed(self):
            """Close and relaunch Chromium once it has served browser_recycle_after_tasks tasks.

            Called from inside a @pw task, so it leaves a live BrowserContext and Page
            behind for the @pw wrapper to close when the task finishes. Assumes the
            default multiplier of 1, i.e. one browser per user.
            """
            self.browser_task_count[0] += 1
            if self.browser_recycle_after_tasks <= 0:
                return
            if self.browser_task_count[0] < self.browser_recycle_after_tasks:
                return
            self.browser_task_count[0] = 0
            logging.info(f"Recycling headless browser after {self.browser_recycle_after_tasks} tasks")
            try:
                if self.page is not None:
                    await self.page.close()
                if self.browser_context is not None:
                    await self.browser_context.close()
                if self.browser is not None:
                    await self.browser.close()
                self.browser = None
                self.browser_context = None
                await self._pwprep()  # relaunches Chromium, reuses the Playwright driver
                self.browser_context = await self.browser.new_context(ignore_https_errors=True, base_url=self.host)
                self.page = await self.browser_context.new_page()
            except Exception as e:
                logging.error(f"Error recycling headless browser: {str(e)}")

        def on_stop(self):
            # PlaywrightUser has no teardown, so a stopped user would otherwise leave its
            # Chromium and its Playwright driver running for the life of the process.
            for user in self.sub_users or [self]:
                try:
                    future = asyncio.run_coroutine_threadsafe(user.close_browser(), playwright_plugin.loop)
                    while not future.done():
                        gevent.sleep(0.1)
                    future.result()
                except Exception as e:
                    logging.error(f"Error closing headless browser: {str(e)}")

        async def close_browser(self):
            if self.browser is not None:
                await self.browser.close()
                self.browser = None
            self.browser_context = None
            if self.playwright is not None:
                await self.playwright.stop()
                self.playwright = None

        @task
        @pw
        async def open_cart_page_and_change_currency(self, page: PageWithRetry):
            tracer = trace.get_tracer(__name__)
            with tracer.start_as_current_span("browser_change_currency", context=Context()):
                try:
                    page.on("console", lambda msg: print(msg.text))
                    await page.route('**/*', add_baggage_header)
                    await page.goto("/cart", wait_until="domcontentloaded")
                    await page.select_option('[name="currency_code"]', 'CHF')
                    await page.wait_for_timeout(2000)  # giving the browser time to export the traces
                    logging.info("Currency changed to CHF")
                except Exception as e:
                    logging.error(f"Error in change currency task: {str(e)}")
            await self.recycle_browser_if_needed()

        @task
        @pw
        async def add_product_to_cart(self, page: PageWithRetry):
            tracer = trace.get_tracer(__name__)
            with tracer.start_as_current_span("browser_add_to_cart", context=Context()):
                try:
                    page.on("console", lambda msg: print(msg.text))
                    await page.route('**/*', add_baggage_header)
                    await page.goto("/", wait_until="domcontentloaded")
                    # Wait for Roof Binoculars image to load (awaiting successful XHR response in less than 15 seconds)
                    await page.wait_for_event(
                        "response",
                        predicate=lambda r: '/images/products/RoofBinoculars.jpg' in r.url and r.status == 200,
                        timeout=15000
                    )
                    await page.click('p:has-text("Roof Binoculars")')
                    await page.wait_for_load_state("domcontentloaded")
                    await page.click('button:has-text("Add To Cart")')
                    await page.wait_for_load_state("domcontentloaded")
                    await page.wait_for_timeout(2000)  # giving the browser time to export the traces
                    logging.info("Product added to cart successfully")
                except Exception as e:
                    logging.error(f"Error in add to cart task: {str(e)}")
            await self.recycle_browser_if_needed()

async def add_baggage_header(route: Route, request: Request):
    existing_baggage = request.headers.get('baggage', '')
    headers = {
        **request.headers,
        'baggage': ', '.join(filter(None, (existing_baggage, 'synthetic_request=true')))
    }
    await route.continue_(headers=headers)
