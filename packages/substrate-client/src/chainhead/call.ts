import type { OperationCallDone } from "./internal-types"
import { createOperationPromise } from "./operation-promise"

export const createCallFn = createOperationPromise(
  "chainHead_unstable_call",
  (hash: string, fnName: string, callParameters: string) => [
    [hash, fnName, callParameters],
    (e: OperationCallDone, res: (output: string) => void) => {
      res(e.output)
    },
  ],
)
