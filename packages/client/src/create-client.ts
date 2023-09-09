import {
  FollowEventWithRuntime,
  FollowResponse,
  SubstrateClient,
} from "@unstoppablejs/substrate-client"
import {
  ArgsWithPayloadCodec,
  Codec,
  ConstantDescriptor,
  DescriptorCommon,
  ErrorDescriptor,
  EventDescriptor,
  StorageDescriptor,
  TxDescriptor,
  V14,
  getPalletCreator,
} from "@unstoppablejs/substrate-bindings"
import { Observable, Subject, mergeMap, share, shareReplay, take } from "rxjs"
import {
  getChecksumBuilder,
  getDynamicBuilder,
} from "@unstoppablejs/substrate-codegen"

export interface DeferredPromise<T> {
  promise: Promise<T>
  res: (value: T) => void
  rej: (err: Error) => void
}

const getCodecsFromMetadata = (
  metadata: V14,
  descriptors: {
    storage: Array<StorageDescriptor<DescriptorCommon<string, string>, any>>
  },
) => {
  const codecs = getDynamicBuilder(metadata)
  const checksums = getChecksumBuilder(metadata)

  const storage: Record<
    string,
    Record<string, { key: Codec<any>; val: Codec<any> }>
  > = {}
  descriptors.storage
    .filter(
      (x) =>
        x.props.checksum ===
        checksums.buildStorage(x.props.pallet, x.props.name),
    )
    .forEach(({ props: { pallet, name } }) => {
      const palletEntry = storage[pallet] ?? (storage[pallet] = {})
      palletEntry[name] = codecs.buildStorage(pallet, name)
    })

  return {
    storage,
  }
}

export function createPullClient<
  StorageDescriptors extends Array<StorageDescriptor<any, any>>,
>(
  substrateClient: SubstrateClient,
  descriptors: {
    storage: StorageDescriptors
  },
) {
  const _followResponse$ = new Subject<FollowResponse>()
  const followResponse$ = _followResponse$.pipe(shareReplay(1))

  const blocksUsed = new Map<string, number>()

  const onUseBlock = (block: string) => {
    const count = blocksUsed.get(block) ?? 0
    blocksUsed.set(block, count + 1)
  }

  const onDisposeBlock = (block: string) => {
    const currentCount = blocksUsed.get(block)
    if (!currentCount) {
      console.warn(`unused block got disposed: ${block}`)
      return
    }

    if (currentCount > 1) {
      blocksUsed.set(block, currentCount - 1)
    } else {
      blocksUsed.delete(block)
      followResponse$.pipe(take(1)).subscribe((f) => f.unpin([block]))
    }
  }

  const chainHead$ = new Observable<FollowEventWithRuntime>((observer) => {
    const _follower = substrateClient.chainHead(
      true,
      observer.next.bind(observer),
      (e) => {
        observer.error(e)
        _followResponse$.error(e)
      },
    )

    _followResponse$.next(_follower)
    return () => {
      _follower.unfollow()
    }
  }).pipe(share())

  const finalized$: Observable<string> = chainHead$.pipe(
    mergeMap((e) => {
      if (e.event === "initialized") return [e.finalizedBlockHash]
      if (e.event === "finalized") return e.finalizedBlockHashes
      return []
    }),
    shareReplay(1),
  )

  return null as any
}

export type Descriptor<T extends DescriptorCommon<any, any>> =
  | ConstantDescriptor<T, any>
  | EventDescriptor<T, any>
  | StorageDescriptor<T, any>
  | ErrorDescriptor<T, any>
  | TxDescriptor<T, any, any, any>

export type TupleToIntersection<T extends Array<any>> = T extends [
  infer V,
  ...infer Rest,
]
  ? V & TupleToIntersection<Rest>
  : unknown

type StorageFunction<Args, Payload> = Args extends Array<any>
  ? (...args: Args) => Promise<Payload>
  : unknown

type MapStorageDescriptor<A extends Array<StorageDescriptor<any, any>>> = {
  [K in keyof A]: A[K] extends StorageDescriptor<
    DescriptorCommon<infer P, infer N>,
    ArgsWithPayloadCodec<infer Args, infer Payload>
  >
    ? { [K in P]: { [KK in N]: StorageFunction<Args, Payload> } }
    : unknown
}

export function foo<A extends Array<StorageDescriptor<any, any>>>(
  ..._: A
): TupleToIntersection<MapStorageDescriptor<A>> {
  return null as any
}

const fooPallet = getPalletCreator("foo")
export const fooStorageS = fooPallet.getStorageDescriptor(
  1n,
  "fooNameFirst",
  [] as ArgsWithPayloadCodec<[foo: string, bar: number], boolean>,
)
export const fooStorageT = fooPallet.getStorageDescriptor(
  1n,
  "fooNameSecond",
  [] as ArgsWithPayloadCodec<[foos: string, bas: number], bigint>,
)

const barPallet = getPalletCreator("bar")
export const barStorageS = barPallet.getStorageDescriptor(
  1n,
  "barNameFirst",
  [],
)
export const barStorageT = barPallet.getStorageDescriptor(
  1n,
  "barNameSecond",
  [],
)

const test = foo(fooStorageS, fooStorageT, barStorageS, barStorageT)
