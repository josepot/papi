import { Tuple, V14, compact, metadata } from "@polkadot-api/substrate-bindings"
import {
  Finalized,
  FollowEventWithRuntime,
  FollowResponse,
  Runtime,
  SubstrateClient,
} from "@polkadot-api/substrate-client"
import {
  Observable,
  ReplaySubject,
  Subject,
  concat,
  delay,
  distinctUntilChanged,
  filter,
  map,
  merge,
  mergeMap,
  noop,
  of,
  scan,
  share,
  switchMap,
  take,
  takeWhile,
  withLatestFrom,
} from "rxjs"
import { getWithRecovery } from "./withOperationLimitRecovery"

const shareLatest: <T>(base: Observable<T>) => Observable<T> = share({
  connector: () => new ReplaySubject(1),
  resetOnError: true,
  resetOnComplete: true,
  resetOnRefCountZero: true,
})

export const fromAbortControllerFn =
  <A extends Array<any>, T>(
    fn: (...args: [...A, ...[abortSignal: AbortSignal]]) => Promise<T>,
  ) =>
  (...args: A): Observable<T> =>
    new Observable((observer) => {
      let aborter: AbortController | undefined = new AbortController()

      fn(...[...args, aborter.signal]).then(
        (value: any) => {
          observer.next(value)
          observer.complete()
        },
        (error: any) => {
          observer.error(error)
        },
      )

      return () => {
        observer.unsubscribe()
        aborter!.abort()
        aborter = undefined
      }
    })

const opaqueMeta = Tuple(compact, metadata)

type WithHashOptional<T extends (hash: string, ...rest: any[]) => any> =
  T extends (hash: string, ...rest: infer A) => infer R
    ? (hash: string | null, ...rest: A) => R
    : unknown

const getUnpinHandlers = (
  finalized$: Observable<string>,
  chainHead$: Observable<FollowEventWithRuntime>,
  unpin: (hashes: string[]) => void,
) => {
  const userUsage$ = new Subject<{
    type: "hold" | "release"
    hash: string
  }>()

  const internalUsage$ = finalized$.pipe(
    mergeMap((hash) =>
      merge(
        of({ type: "hold" as "hold", hash }),
        of({ type: "release" as "release", hash }).pipe(delay(0)),
      ),
    ),
  )

  const unpinFromUsage$ = merge(userUsage$, internalUsage$).pipe(
    scan(
      (acc, usage) => {
        const newAcc = Object.fromEntries(
          Object.entries(acc).filter(([, value]) => value),
        )
        if (usage.type === "release") {
          newAcc[usage.hash]--
        } else {
          newAcc[usage.hash] ||= 0
          newAcc[usage.hash]++
        }
        return newAcc
      },
      {} as Record<string, number>,
    ),
    map((acc) =>
      Object.entries(acc)
        .filter(([, value]) => value === 0)
        .map(([key]) => key),
    ),
  )

  const unpinFromPrunned$ = chainHead$.pipe(
    filter((e): e is Finalized => e.type === "finalized"),
    map((e) => e.prunedBlockHashes),
  )

  merge(unpinFromUsage$, unpinFromPrunned$).subscribe((hashes) => {
    unpin(hashes)
  })

  return {
    onHold(hash: string) {
      userUsage$.next({ type: "hold", hash })
    },
    onRelease(hash: string) {
      setTimeout(() => {
        userUsage$.next({ type: "release", hash })
      }, 0)
    },
  }
}

export const withObservable = (base: SubstrateClient) => {
  const chainHead = (): Omit<FollowResponse, "unpin"> & {
    chainHead$: Observable<FollowEventWithRuntime>
    runtime$: Observable<Runtime>
    metadata$: Observable<V14 | null>
    header: WithHashOptional<FollowResponse["header"]>
    body: WithHashOptional<FollowResponse["body"]>
    call: WithHashOptional<FollowResponse["call"]>
    storage: WithHashOptional<FollowResponse["storage"]>
  } => {
    const withRecovery = getWithRecovery()
    const withRecoveryFn =
      <Args extends Array<any>, T>(fn: (...args: Args) => Observable<T>) =>
      (...args: Args) =>
        withRecovery(fn(...args))

    let follower: FollowResponse
    let unfollow: () => void = noop

    const chainHead$ = new Observable<FollowEventWithRuntime>((observer) => {
      follower = base.chainHead(
        true,
        (e) => {
          observer.next(e)
        },
        (e) => {
          observer.error(e)
        },
      )

      unfollow = () => {
        follower.unfollow()
        observer.complete()
      }
    }).pipe(share())

    const runtime$ = chainHead$.pipe(
      scan(
        (acc, event) => {
          if (event.type === "initialized") {
            acc.candidates.clear()
            acc.current = event.finalizedBlockRuntime
          }

          if (event.type === "newBlock" && event.newRuntime)
            acc.candidates.set(event.blockHash, event.newRuntime)

          if (event.type !== "finalized") return acc

          const [newRuntimeHash] = event.finalizedBlockHashes
            .filter((h) => acc.candidates.has(h))
            .slice(-1)
          if (newRuntimeHash) acc.current = acc.candidates.get(newRuntimeHash)!

          acc.candidates.clear()
          return acc
        },
        {
          candidates: new Map<string, Runtime>(),
          current: {} as Runtime,
        },
      ),
      map((x) => x.current),
      distinctUntilChanged(),
    )

    const finalized$: Observable<string> = chainHead$.pipe(
      mergeMap((e) => {
        if (e.type === "finalized") return e.finalizedBlockHashes
        if (e.type !== "initialized") return []
        return [e.finalizedBlockHash]
      }),
      shareLatest,
    )

    const getMetadata$ = (hash: string) =>
      call$(hash, "Metadata_metadata", "").pipe(
        map((response) => {
          const metadata = opaqueMeta.dec(response)[1]
          if (metadata.metadata.tag !== "v14")
            throw new Error("Wrong metadata version")
          return metadata.metadata.value
        }),
      )

    const metadata$ = runtime$.pipe(
      withLatestFrom(finalized$),
      switchMap(([, latestBlock]) => concat([null], getMetadata$(latestBlock))),
      shareLatest,
    )

    // no need to capture the unsubscription b/c it will complete
    // once the consumer calls `unfollow`
    metadata$.subscribe()

    const delayUnsubscription = <T>(source$: Observable<T>) =>
      new Observable<T>((observer) => {
        const subscription = source$.subscribe(observer)
        return () => {
          setTimeout(() => {
            subscription.unsubscribe()
          }, 0)
        }
      })

    const current$ = finalized$.pipe(
      take(1),
      share({
        connector: () => new ReplaySubject(1),
        resetOnError: true,
        resetOnRefCountZero: true,
        resetOnComplete: false,
      }),
      delayUnsubscription,
    )

    const DONE = Symbol("DONE")
    type DONE = typeof DONE

    const withOptionalHash$ =
      <Args extends Array<any>, T>(
        fn: (hash: string, ...args: Args) => Observable<T>,
      ) =>
      (hash: string | null, ...args: Args) =>
        hash
          ? fn(hash, ...args)
          : current$.pipe(
              mergeMap((h) => concat(fn(h, ...args), of(DONE))),
              takeWhile((x): x is T => x !== DONE),
            )

    const { onHold, onRelease } = getUnpinHandlers(
      finalized$,
      chainHead$,
      follower!.unpin,
    )

    const withUnpinning$ =
      <Args extends Array<any>, T>(
        fn: (hash: string, ...args: Args) => Observable<T>,
      ) =>
      (hash: string, ...args: Args): Observable<T> => {
        const base$ = fn(hash, ...args)
        return new Observable<T>((observer) => {
          onHold(hash)
          const subscription = base$.subscribe(observer)
          return () => {
            subscription.unsubscribe()
            onRelease(hash)
          }
        })
      }

    const call$ = withOptionalHash$(
      withUnpinning$(withRecoveryFn(fromAbortControllerFn(follower!.call))),
    )

    const body$ = withOptionalHash$(
      withUnpinning$(withRecoveryFn(fromAbortControllerFn(follower!.call))),
    )

    const head$ = withOptionalHash$(
      withUnpinning$(fromAbortControllerFn(follower!.call)),
    )

    return {
      chainHead$,
      runtime$,
      metadata$,
      header: header!,
      body: body!,
      call: call!,
      storage: storage!,
      storageSubscription: follower!.storageSubscription,
      unfollow,
      _request: follower!._request,
    }
  }

  return {
    ...base,
    chainHead,
  }
}
