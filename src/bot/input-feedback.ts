import type { Address, ChannelAdapter } from "../core/channel.ts";
import type { FeedbackMessage } from "../core/wake.ts";
import type { Print } from "../gateway/config.ts";

const TYPING_REFRESH_MS = 7_000;
const REQUEST_MS = 3_000;

export interface FeedbackTarget {
  message: Address;
  place: Address;
  thread?: Address;
}

interface TypingSession {
  ready: Promise<void>;
  timer: NodeJS.Timeout;
  users: number;
}

export type FeedbackLease = ReturnType<InputFeedback["start"]>;

/** Holds one typing timer per place or thread, across simultaneous decisions and submissions. */
export class InputFeedback {
  readonly #typing = new Map<Address, TypingSession>();

  readonly #adapter: (address: Address) => ChannelAdapter | undefined;
  readonly #print: Print;

  constructor(adapter: (address: Address) => ChannelAdapter | undefined, print: Print) {
    this.#adapter = adapter;
    this.#print = print;
  }

  targets(messages: readonly FeedbackMessage[], place: Address): FeedbackTarget[] {
    return messages
      .filter(({ message }) => this.#adapter(message)?.inputFeedback)
      .map(({ message, thread }) => ({ message, place, ...(thread ? { thread } : {}) }));
  }

  start(targets: readonly FeedbackTarget[], acknowledge: boolean) {
    const venues = new Map(targets.map((target) => [target.thread ?? target.place, target]));
    const typing = [...venues.values()].map((target) => this.#holdTyping(target));
    const ready = Promise.all([
      ...typing.map((session) => session.ready),
      ...(acknowledge ? targets.map(({ message }) => this.#status(message, "processing")) : []),
    ]).then(() => {});
    return {
      ready,
      stop: () => {
        for (const session of typing) session.release();
      },
    };
  }

  async finish(targets: readonly FeedbackTarget[], completed: boolean): Promise<void> {
    await Promise.all(targets.map(({ message }) => this.#status(message, completed ? "completed" : "failed")));
  }

  async #status(message: Address, state: "processing" | "completed" | "failed"): Promise<void> {
    try {
      await this.#adapter(message)?.inputFeedback?.status(message, state, AbortSignal.timeout(REQUEST_MS));
    } catch (error) {
      this.#print("input status failed", { message, state, error: String(error) });
    }
  }

  #holdTyping({ place, thread }: FeedbackTarget) {
    const key = thread ?? place;
    let session = this.#typing.get(key);
    if (!session) {
      let failed = false;
      const show = async () => {
        try {
          await this.#adapter(place)?.inputFeedback?.typing(place, thread, AbortSignal.timeout(REQUEST_MS));
        } catch (error) {
          if (!failed) this.#print("input typing failed", { place, thread, error: String(error) });
          failed = true;
        }
      };
      const timer = setInterval(show, TYPING_REFRESH_MS).unref();
      session = { ready: show(), timer, users: 0 };
      this.#typing.set(key, session);
    }
    const held = session;
    held.users++;
    let released = false;
    return {
      ready: held.ready,
      release: () => {
        if (released) return;
        released = true;
        if (--held.users === 0) {
          clearInterval(held.timer);
          this.#typing.delete(key);
        }
      },
    };
  }
}
