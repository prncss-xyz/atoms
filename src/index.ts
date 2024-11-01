import {
  fromInit,
  Init,
  isFunction,
  REMOVE,
  shallowEqual,
  Updater,
} from "@constellar/core";
import { useRef, useSyncExternalStore } from "react";

export interface IRAtom<Value> {
  peek(): Value;
  subscribe(subscriber: () => void): () => void;
}

export interface IWAtom<Args extends unknown[], R> {
  send(...args: Args): R;
}

export interface IRWAtom<Value, Args extends unknown[], R>
  extends IRAtom<Value>,
    IWAtom<Args, R> {}

export abstract class RAtom<State> implements IRAtom<State> {
  private subscribers: Set<() => void> = new Set();
  private unmount: void | (() => void) = undefined;
  private dirty = true;
  // `dirty = true` ensures initial undefined value is never read
  protected state = undefined as State;
  protected abstract read(): State;
  protected abstract onMount(): void | (() => void);
  subscribe(subscriber: () => void) {
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
  peek() {
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
  update(next: State) {
    this.state = next;
    this.notify();
  }
  invalidate() {
    this.dirty = true;
    this.notify();
  }
}

// TODO: middleware
export class StoreAtom<State>
  extends RAtom<State>
  implements IRWAtom<State, [Updater<State, never>], void>
{
  constructor(private init: Init<State | Promise<State>>) {
    super();
  }
  // REMOVE as state means that the store is not initialized yet
  res: State | Promise<State> | typeof REMOVE = REMOVE;
  read() {
    if (this.res === REMOVE) {
      this.res = fromInit(this.init);
      if (this.res instanceof Promise) {
        setTimeout(async () => {
          const res = (await this.res) as State;
          this.init = res; // this enables reset
          this.update(res);
        }, 0);
      }
    }
    if (this.res instanceof Promise) {
      throw this.res;
    }
    return this.res;
  }
  onMount() {}
  // REMOVE as event means that the store is to be reset
  send(up: Updater<State, typeof REMOVE>) {
    const state = this.peek();
    const next = isFunction(up) ? up(state) : up === REMOVE ? this.init : up;
    if (Object.is(next, state)) return;
    this.update(next);
  }
}

export function storeAtom<State>(init: Init<State | Promise<State>>) {
  return new StoreAtom(init);
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
  read() {
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
  onMount() {
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

export async function setAtom<Args extends unknown[], R>(
  atom: IWAtom<Args, R>,
  ...args: Args
): Promise<R> {
  try {
    return atom.send(...args);
  } catch (e) {
    if (e instanceof Promise) {
      await e;
      return setAtom(atom, ...args);
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
        if (!shallowEqual(acc.current, next)) {
          acc.current = next;
          nofity();
        }
      }),
    () => acc.current,
    () => atom.peek(), // TODO: manage server-side rendering
  );
}
