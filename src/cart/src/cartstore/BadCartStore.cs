// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
using System.Threading.Tasks;
using Grpc.Core;
using Oteldemo;

namespace cart.cartstore;

/// <summary>
/// A cart store implementation that intentionally fails all operations.
/// Used by the cartFailure feature flag to simulate cart service outages
/// without needing to misconfigure a real connection.
/// </summary>
public class BadCartStore : ICartStore
{
    private const string ErrorMessage = "Cart service is in failure mode (cartFailure feature flag is enabled).";

    public void Initialize()
    {
        // No initialization needed for the bad store.
    }

    public Task AddItemAsync(string userId, string productId, int quantity)
    {
        throw new RpcException(new Status(StatusCode.FailedPrecondition, ErrorMessage));
    }

    public Task EmptyCartAsync(string userId)
    {
        throw new RpcException(new Status(StatusCode.FailedPrecondition, ErrorMessage));
    }

    public Task<Cart> GetCartAsync(string userId)
    {
        throw new RpcException(new Status(StatusCode.FailedPrecondition, ErrorMessage));
    }

    public bool Ping()
    {
        return false;
    }
}