/** Let Electron finish cancelling its current native termination before retrying. */
export function requestNativeQuit(quit: () => void): void {
  setImmediate(quit)
}
