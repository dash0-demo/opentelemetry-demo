// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
using System.Threading.Tasks;
using Grpc.Core;

namespace cart.cartstore;

/// <summary>
/// A cart store implementation that always throws an exception immediately.
/// Used by the cartFailure feature flag to simulate cart storage failures
/// without attempting a real network connection to a non-existent host.
/// This replaces the previous approach of using a ValkeyCartStore pointed
/// at "badhost:1234", which caused slow connection timeouts on every call
/// and generated misleading "Wasn't able to connect to redis" errors that
/// obscured the intentional nature of the failure injection.
/// </summary>
public class BadCartStore : ICartStore
{
    private const string FailureMessage = "Cart storage is unavailable (cartFailure feature flag is enabled).";

    public void Initialize()
    {
        // No-op: BadCartStore does not connect to any backend.
    }

    public Task AddItemAsync(string userId, string productId, int quantity)
    {
        throw new RpcException(new Status(StatusCode.FailedPrecondition, FailureMessage));
    }

    public Task EmptyCartAsync(string userId)
    {
        throw new RpcException(new Status(StatusCode.FailedPrecondition, FailureMessage));
    }

    public Task<Oteldemo.Cart> GetCartAsync(string userId)
    {
        throw new RpcException(new Status(StatusCode.FailedPrecondition, FailureMessage));
    }

    public bool Ping()
    {
        return false;
    }
}
