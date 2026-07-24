// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
using System.Diagnostics;
using System.Threading.Tasks;
using System;
using Grpc.Core;
using cart.cartstore;
using Microsoft.Extensions.Logging;
using OpenFeature;
using Oteldemo;

namespace cart.services;

public class CartService : Oteldemo.CartService.CartServiceBase
{
    private static readonly Empty Empty = new();
    private readonly Random random = new Random();
    private readonly ICartStore _badCartStore;
    private readonly ICartStore _cartStore;
    private readonly IFeatureClient _featureFlagHelper;
    private readonly ILogger<CartService> _logger;

    public CartService(ICartStore cartStore, ICartStore badCartStore, IFeatureClient featureFlagService, ILogger<CartService> logger)
    {
        _badCartStore = badCartStore;
        _cartStore = cartStore;
        _featureFlagHelper = featureFlagService;
        _logger = logger;
    }

    public override async Task<Empty> AddItem(AddItemRequest request, ServerCallContext context)
    {
        var activity = Activity.Current;
        activity?.SetTag("user.id", request.UserId);
        activity?.SetTag("demo.product.id", request.Item.ProductId);
        activity?.SetTag("demo.product.quantity", request.Item.Quantity);

        try
        {
            await _cartStore.AddItemAsync(request.UserId, request.Item.ProductId, request.Item.Quantity);

            return Empty;
        }
        catch (RpcException ex)
        {
            activity?.AddException(ex);
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            throw;
        }
    }

    public override async Task<Cart> GetCart(GetCartRequest request, ServerCallContext context)
    {
        var activity = Activity.Current;
        activity?.SetTag("user.id", request.UserId);
        activity?.AddEvent(new("Fetch cart"));

        try
        {
            var cart = await _cartStore.GetCartAsync(request.UserId);
            var totalCart = 0;
            foreach (var item in cart.Items)
            {
                totalCart += item.Quantity;
            }
            activity?.SetTag("demo.cart.items.count", totalCart);

            return cart;
        }
        catch (RpcException ex)
        {
            activity?.AddException(ex);
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            throw;
        }
    }

    public override async Task<Empty> EmptyCart(EmptyCartRequest request, ServerCallContext context)
    {
        var activity = Activity.Current;
        activity?.SetTag("user.id", request.UserId);
        activity?.AddEvent(new("Empty cart"));

        try
        {
            if (await _featureFlagHelper.GetBooleanValueAsync("cartFailure", false))
            {
                // cartFailure feature flag is enabled: simulate a cart storage failure
                // for observability demo purposes.
                activity?.SetTag("feature_flag.cartFailure", true);
                _logger.LogWarning("cartFailure feature flag enabled for user {UserId} — routing EmptyCart to bad store to simulate fault", request.UserId);
                await _badCartStore.EmptyCartAsync(request.UserId);
            }
            else
            {
                await _cartStore.EmptyCartAsync(request.UserId);
            }
        }
        catch (RpcException ex)
        {
            Activity.Current?.AddException(ex);
            Activity.Current?.SetStatus(ActivityStatusCode.Error, ex.Message);
            _logger.LogError(ex, "EmptyCart failed for user {UserId}: {Message}", request.UserId, ex.Message);
            throw;
        }

        return Empty;
    }
}
