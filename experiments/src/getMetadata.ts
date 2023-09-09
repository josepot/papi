import { createClient } from "@unstoppablejs/substrate-client"
import {
  compact,
  metadata,
  CodecType,
  Tuple,
} from "@unstoppablejs/substrate-bindings"

import {
  Chain,
  WellKnownChain,
  createScClient,
  Config,
  ScClient,
} from "@substrate/connect"
import { ProviderStatus } from "@unstoppablejs/provider"
import collectivesSpec from "./collectives-polkadot"
import collectivesPolkadot from "./collectives-polkadot"

const wellKnownChains = new Set(Object.values(WellKnownChain))

let client: ScClient
export const ScProvider = (
  input: WellKnownChain | string,
  config?: Config,
): GetProvider => {
  // Share the same client, if not adding Westmint throws AddChainError: Couldn't find relevant relay chain
  client ??= createScClient(config)

  return (onMessage, onStatus): Provider => {
    let chain: Chain

    const open = () => {
      ;(wellKnownChains.has(input as any)
        ? client.addWellKnownChain(input as WellKnownChain, onMessage)
        : client.addChain(input, onMessage)
      ).then((_chain) => {
        chain = _chain
        onStatus(ProviderStatus.ready)
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

ScProvider(WellKnownChain.polkadot)(
  Function.prototype as any,
  Function.prototype as any,
).open()

await new Promise((res) => setTimeout(res, 500))

const smProvider = ScProvider(
  collectivesPolkadot /*, {
  embeddedNodeConfig: {
    maxLogLevel: 9,
  },
}*/,
)

export interface Provider {
  send: (message: string) => void
  open: () => void
  close: () => void
}

export declare type GetProvider = (
  onMessage: (message: string) => void,
  onStatus: (status: ProviderStatus) => void,
) => Provider

const withLogsProvider = (input: GetProvider): GetProvider => {
  return (onMsg, onStatus) => {
    const result = input(
      (msg) => {
        console.log("<< " + msg)
        onMsg(msg)
      },
      (status) => {
        console.log("STATUS CHANGED =>" + status)
        onStatus(status)
      },
    )

    return {
      ...result,
      send: (msg) => {
        console.log(">> " + msg)
        result.send(msg)
      },
    }
  }
}

export const { chainHead } = createClient(smProvider)

type Metadata = CodecType<typeof metadata>

const opaqueMeta = Tuple(compact, metadata)

export const getMetadata = (): Promise<Metadata> =>
  new Promise<Metadata>((res, rej) => {
    let requested = false
    const chainHeadFollower = chainHead(
      true,
      (message) => {
        if (message.event === "newBlock") {
          chainHeadFollower.unpin([message.blockHash])
          return
        }
        if (requested || message.event !== "initialized") return
        const latestFinalized = message.finalizedBlockHash
        if (requested) return
        requested = true

        chainHeadFollower
          .call(latestFinalized, "Metadata_metadata", "")
          .then((response) => {
            const [, metadata] = opaqueMeta.dec(response)
            res(metadata)
          })
          .catch((e) => {
            console.log("error", e)
            rej(e)
          })
          .finally(() => {
            chainHeadFollower.unfollow()
          })
      },
      () => {},
    )
  })
