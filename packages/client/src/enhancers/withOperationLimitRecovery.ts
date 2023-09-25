import { OperationLimitError } from "@polkadot-api/substrate-client"
import type { Subscriber } from "rxjs"
import { Observable, noop } from "rxjs"

interface Node<T> {
  value: T
  next?: Node<T>
  prev?: Node<T>
}

export default class PendigTasksQueue<T> {
  private first?: Node<T>
  private last?: Node<T>

  private getRemoveFn(node: Node<T>) {
    return () => {
      if (node.prev) {
        node.prev.next = node.next
      } else {
        this.first = node.next
      }

      if (node.next) {
        node.next.prev = node.prev
      } else {
        this.last = node.prev
      }

      delete node.prev
      delete node.next
    }
  }

  push(value: T) {
    const newNode: Node<T> = { value }

    if (this.last === undefined) {
      this.last = this.first = newNode
    } else {
      this.last.next = newNode
      newNode.prev = this.last

      this.last = newNode
    }

    return this.getRemoveFn(newNode)
  }

  unshift(value: T) {
    this.first = { value, next: this.first }
    this.first.next && (this.first.next.prev = this.first)
    this.last ||= this.first
    return this.getRemoveFn(this.first)
  }

  pop() {
    const result = this.first?.value

    if (this.first) {
      this.first = this.first.next

      if (!this.first) {
        this.last = undefined
      } else {
        delete this.first.prev?.next
        delete this.first.prev
      }
    }

    return result
  }

  isEmpty() {
    return !this.first
  }
}

export const getWithRecovery = () => {
  const pendingTasks = new PendigTasksQueue<{
    observer: Subscriber<any>
    source$: Observable<any>
  }>()

  const tearDownOperations = new Map<Observable<any>, () => void>()
  const setTeardown = (observable: Observable<any>, cb: () => void) => {
    tearDownOperations.set(observable, () => {
      tearDownOperations.delete(observable)
      cb()
    })
  }

  const addTeardwon = (observable: Observable<any>, cb: () => void) => {
    const current = tearDownOperations.get(observable)

    tearDownOperations.set(observable, () => {
      if (current) {
        current()
      } else {
        tearDownOperations.delete(observable)
      }
      cb()
    })
  }

  const teardown = (observable: Observable<any>) => {
    tearDownOperations.get(observable)?.()
  }

  const unshiftTask = (data: {
    observer: Subscriber<any>
    source$: Observable<any>
  }) => {
    setTeardown(data.source$, pendingTasks.unshift(data))
  }

  const onEmptySlot = () => {
    const data = pendingTasks.pop()
    if (!data) return

    tearDownOperations.delete(data.source$)
    process(data)
  }

  const process = (data: {
    observer: Subscriber<any>
    source$: Observable<any>
  }) => {
    const { source$, observer } = data

    let complete = () => {
      observer.complete()
    }

    const subscription = source$.subscribe({
      next(x) {
        if (x instanceof Observable) {
          complete = noop

          addTeardwon(source$, () => {
            teardown(x)
          })

          let currentComplete: any = observer.complete.bind(observer)
          observer.complete = () => {
            teardown(source$)
            currentComplete()
            currentComplete = undefined
          }

          unshiftTask({ source$: x, observer })
        } else {
          observer.next(x)
        }
      },
      error(e) {
        teardown(source$)
        if (e instanceof OperationLimitError) return unshiftTask(data)

        observer.error(e)
        onEmptySlot()
      },
      complete() {
        complete()
        onEmptySlot()
      },
    })

    if (!observer.closed) {
      setTeardown(source$, () => {
        subscription.unsubscribe()
        complete = noop
        observer.complete = noop
      })
    }
  }

  const withRecovery = <T>(
    source$: Observable<T | Observable<T>>,
  ): Observable<T> =>
    new Observable((observer) => {
      const pendingTask = { observer, source$ }

      if (pendingTasks.isEmpty()) {
        process(pendingTask)
      } else {
        setTeardown(source$, pendingTasks.push(pendingTask))
      }

      return () => {
        teardown(source$)
      }
    })

  return withRecovery
}
