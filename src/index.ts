import { isFunction } from "@constellar/core";
import { useRef, useSyncExternalStore } from "react";

type Updater<Value, Command> = Command | Value | ((value: Value) => Value);

export const RESET = Symbol("RESET");

export interface IRAtom<Value> {
  peek(): Value;
  subscribe(subscriber: () => void): () => void;
}

export interface IWAtom<Args extends unknown[], R> {
  send(...args: Args): R;
}

export interface IStateAtom<State>
  extends IRAtom<State>,
    IWAtom<[Updater<State, never>], void> {}

export interface IRWAtom<Value, Args extends unknown[], R>
  extends IRAtom<Value>,
    IWAtom<Args, R> {}

export abstract class RAtom<State> implements IRAtom<State> {
  private subscribers: Set<() => void> = new Set();
  protected unmount: void | (() => void) = undefined;
  private dirty = true;
  // `dirty = true` ensures initial undefined value is never read
  protected state = undefined as State;
  protected abstract read(): State;
  protected abstract onMount(): void | (() => void);
  public subscribe(subscriber: () => void) {
    if (this.subscribers.size === 0) this.unmount = this.onMount();
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
      // we dont't do it sink to avoid unmounting when an observer to subscribe and another to unsubscribe in a sync task
      if (this.unmount && this.subscribers.size === 0) {
        setTimeout(() => {
          if (this.subscribers.size === 0) this.unmount!();
        }, 0);
      }
    };
  }
  public peek() {
    if (this.dirty) {
      this.state = this.read();
      this.dirty = false;
    }
    return this.state;
  }
  private notify() {
    for (const subscriber of this.subscribers) {
      subscriber();
    }
  }
  protected update(next: State) {
    this.state = next;
    this.notify();
  }
  protected invalidate() {
    this.dirty = true;
    this.notify();
  }
}

// TODO: middleware
class SyncAtom<State>
  extends RAtom<State>
  implements IRWAtom<State, [Updater<State, never>], void>
{
  constructor(private res: State) {
    super();
  }
  // REMOVE as state means that the store is not initialized yet
  protected read() {
    return this.res as State;
  }
  protected onMount() {}
  // REMOVE as event means that the store is to be reset
  public send(up: Updater<State, never>) {
    const state = this.peek();
    const next = isFunction(up) ? up(state) : up;
    if (Object.is(next, state)) return;
    this.update(next);
  }
}

function getShifter<State>(
  once: (value: State) => void,
  after: (value: State) => void,
) {
  let first = true;
  return function (value: State) {
    if (first) {
      first = false;
      once(value);
      return;
    }
    after(value);
  };
}

class AsyncAtom<State>
  extends RAtom<State>
  implements IRWAtom<State, [Updater<State, never>], void>
{
  constructor(
    private cb: (set: (value: State) => void) => void | (() => void),
  ) {
    super();
  }
  // REMOVE as state means that the store is not initialized yet
  private res: State | Promise<State> | typeof RESET = RESET;
  protected read() {
    if (this.res === RESET) {
      const res = new Promise<State>(
        (resolve) =>
          (this.unmount = this.cb(
            getShifter<State>(resolve, this.send.bind(this)),
          )),
      );
      this.res = res;
      res.then((res) => this.update(res));
    }
    if (this.res instanceof Promise) {
      throw this.res;
    }
    return this.res;
  }
  protected onMount() {}
  // REMOVE as event means that the store is to be reset
  public send(up: Updater<State, typeof RESET>) {
    const state = this.peek();
    if (up === RESET) {
      this.res = RESET;
      this.invalidate();
      this.unmount?.();
      return;
    }
    const next = isFunction(up) ? up(state) : up;
    if (Object.is(next, state)) return;
    this.update(next);
  }
}

export function syncAtom<State>(init: State) {
  return new SyncAtom(init);
}

export function asyncAtom<State>(
  cb: (set: (value: State) => void) => void | (() => void),
) {
  return new AsyncAtom(cb);
}

export function promiseAtom<State>(cb: () => Promise<State>) {
  return new AsyncAtom((resolve) => {
    cb().then(resolve);
  });
}

type Getter = <Value>(atom: IRAtom<Value>) => Value;
type Setter = <Args extends unknown[], R>(
  atom: IWAtom<Args, R>,
  ...args: Args
) => R;

class DerivedAtom<Value, Args extends unknown[], R>
  extends RAtom<Value>
  implements IRWAtom<Value, Args, R>
{
  constructor(
    private get: (get: Getter) => Value,
    private set: (get: Getter, set: Setter, ...args: Args) => R,
  ) {
    super();
  }
  deps = new Map<IRAtom<unknown>, () => void>();
  send(...args: Args) {
    return this.set(
      (atom) => atom.peek(),
      (atom, ...args) => atom.send(...args),
      ...args,
    );
  }
  protected read() {
    const deps = new Set<IRAtom<unknown>>();
    const state = this.get((atom) => {
      deps.add(atom);
      return atom.peek();
    });
    for (const [dep, cb] of this.deps) {
      if (deps.has(dep)) continue;
      cb();
      this.deps.delete(dep);
    }
    for (const dep of deps) {
      if (this.deps.has(dep)) continue;
      this.deps.set(
        dep,
        dep.subscribe(() => this.invalidate()),
      );
    }
    return state;
  }
  protected onMount() {
    for (const [dep] of this.deps) {
      this.deps.set(
        dep,
        dep.subscribe(() => this.invalidate()),
      );
    }
    return () => {
      for (const [, cb] of this.deps) {
        cb();
      }
    };
  }
}

export async function peekAtom<Value>(atom: IRAtom<Value>): Promise<Value> {
  try {
    return atom.peek();
  } catch (e) {
    if (e instanceof Promise) {
      return e;
    } else throw e;
  }
}

export async function sendAtom<Args extends unknown[], R>(
  atom: IWAtom<Args, R>,
  ...args: Args
): Promise<R> {
  try {
    return atom.send(...args);
  } catch (e) {
    if (e instanceof Promise) {
      await e;
      return sendAtom(atom, ...args);
    } else throw e;
  }
}

export function derivedAtom<Value, Args extends unknown[], R>(
  get: (get: Getter) => Value,
  set: (get: Getter, set: Setter, ...args: Args) => R,
) {
  return new DerivedAtom(get, set);
}

export function useAtom<Value>(atom: IRAtom<Value>) {
  const acc = useRef(atom.peek());
  return useSyncExternalStore(
    (nofity) =>
      atom.subscribe(() => {
        const next = atom.peek();
        if (!Object.is(acc.current, next)) {
          acc.current = next;
          nofity();
        }
      }),
    () => acc.current,
    () => atom.peek(), // TODO: manage server-side rendering
  );
}
