import { Window } from 'happy-dom'

interface DomTestLock {
  tail: Promise<void>
}

const lockKey = '__copilotApiDomTestLock'
const fallbackWindowKey = '__copilotApiDomTestFallbackWindow'
const testGlobal = globalThis as typeof globalThis & {
  [lockKey]?: DomTestLock
  [fallbackWindowKey]?: Window
}
const lock = (testGlobal[lockKey] ??= { tail: Promise.resolve() })
const fallbackWindow = (testGlobal[fallbackWindowKey] ??= new Window({
  url: 'http://localhost',
}))

for (const [name, value] of Object.entries({
  window: fallbackWindow,
  document: fallbackWindow.document,
  navigator: fallbackWindow.navigator,
  HTMLElement: fallbackWindow.HTMLElement,
  HTMLInputElement: fallbackWindow.HTMLInputElement,
  HTMLTextAreaElement: fallbackWindow.HTMLTextAreaElement,
  Event: fallbackWindow.Event,
  MouseEvent: fallbackWindow.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  if (Object.getOwnPropertyDescriptor(globalThis, name)) continue
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
}

export async function acquireDomTestLock(): Promise<() => void> {
  const previous = lock.tail
  const next = Promise.withResolvers<void>()
  lock.tail = previous.then(() => next.promise)
  await previous

  let released = false
  return () => {
    if (released) return
    released = true
    next.resolve()
  }
}
