import {
  Chain,
  WellKnownChain,
  createScClient,
  ScClient,
} from "@substrate/connect"
import type { Config } from "@substrate/connect"
import { ProviderStatus, GetProvider, Provider } from "@unstoppablejs/provider"

const wellKnownChains = new Set(Object.values(WellKnownChain))

let client: ScClient

export const ScProvider = (
  input: WellKnownChain | string,
  config?: Config,
): GetProvider => {
  client ??= createScClient(config)

  return (onMessage, onStatus): Provider => {
    let chain: Chain
    let pending = false

    const open = () => {
      if (chain || pending) return

      pending = true
      ;(wellKnownChains.has(input as any)
        ? client.addWellKnownChain(input as WellKnownChain, onMessage)
        : client.addChain(input, onMessage)
      )
        .then((_chain) => {
          onStatus(ProviderStatus.ready)
        })
        .catch((e) => {
          console.warn("There was a problem adding the Chain")
          console.error(e)
          onStatus(ProviderStatus.halt)
        })
        .finally(() => {
          pending = false
        })
    }

    const close = () => {
      chain?.remove()
    }

    const send = (msg: string) => {
      chain.sendJsonRpc(msg)
    }

    return { open, close, send }
  }
}
