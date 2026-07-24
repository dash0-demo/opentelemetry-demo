// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
using System.Threading.Tasks;
using Grpc.Core;

namespace cart.cartstore;

/// <summary>
/// A cart store implementation that always fails.
/// Used to simulate cart service failure via the cartFailure feature flag.
/// </summary>
public class FailingCartStore : ICartStore
{
    private const string ErrorMessage = "Cart failure has been enabled via feature flag.";

    public void Initialize()
    {
        // No initialization needed for a failing store.
    }

    public Task AddItemAsync(string userId, string productId, int quantity)
    {
        throw new RpcException(new Status(StatusCode.FailedPrecondition, ErrorMessage));
    }

    public Task EmptyCartAsync(string userId)
    {
        throw new RpcException(new Status(StatusCode.FailedPrecondition, ErrorMessage));
    }

    public Task<Oteldemo.Cart> GetCartAsync(string userId)
    {
        throw new RpcException(new Status(StatusCode.FailedPrecondition, ErrorMessage));
    }

    public bool Ping()
    {
        return false;
    }
}
