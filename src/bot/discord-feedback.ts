import type { Address, ChannelAdapter } from "../core/channel.ts";
import type { InputFeedbackEvent } from "../core/wake.ts";
import type { Print } from "../gateway/config.ts";

const RECEIVED = "👀";
const COMPLETED = "☑️";
const REFRESH_MS = 7_000;
const REQUEST_MS = 3_000;

export type FeedbackTarget = { message: Address; to: Address };
type TypingSession = {
  users: number;
  reported: boolean;
  ready: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
};

/** Report input progress independently of the judge and the agent's tools. */
export class DiscordFeedback {
  readonly #typing = new Map<Address, TypingSession>();

  readonly #adapter: (address: Address) => ChannelAdapter | undefined;
  readonly #print: Print;

  constructor(adapter: (address: Address) => ChannelAdapter | undefined, print: Print) {
    this.#adapter = adapter;
    this.#print = print;
  }

  targets(events: readonly InputFeedbackEvent[], place: Address): FeedbackTarget[] {
    return events.flatMap((event) => {
      if (event.kind !== "message" || !event.message || event.deleted || !this.#adapter(event.message)?.typing) return [];
      return [{ message: event.message, to: event.thread ?? place }];
    });
  }

  start(targets: readonly FeedbackTarget[], acknowledge: boolean) {
    const typing = [...new Set(targets.map(({ to }) => to))].map((to) => this.#holdTyping(to));
    const ready = Promise.all([
      ...typing.map((session) => session.ready),
      ...(acknowledge ? targets.map(({ message }) => this.#react(message, RECEIVED)) : []),
    ]);
    return { ready, stop: () => typing.forEach((session) => session.release()) };
  }

  async finish(targets: readonly FeedbackTarget[], completed: boolean): Promise<void> {
    await Promise.all(targets.map(async ({ message }) => {
      if (completed) await this.#react(message, COMPLETED);
      await this.#react(message, RECEIVED, true);
    }));
  }

  async #react(message: Address, emoji: string, remove = false): Promise<void> {
    try {
      await this.#adapter(message)?.react(message, emoji, remove, AbortSignal.timeout(REQUEST_MS));
    } catch (error) {
      this.#print("Discord input reaction failed", { message, emoji, remove, error: String(error) });
    }
  }

  #holdTyping(to: Address) {
    let entry = this.#typing.get(to);
    if (!entry) {
      const session: TypingSession = { users: 0, reported: false, ready: Promise.resolve() };
      const show = async () => {
        try {
          await this.#adapter(to)?.typing?.(to, AbortSignal.timeout(REQUEST_MS));
        } catch (error) {
          if (this.#typing.get(to) === session && !session.reported) {
            session.reported = true;
            this.#print("Discord input typing failed", { to, error: String(error) });
          }
        }
      };
      this.#typing.set(to, session);
      session.ready = show();
      session.timer = setInterval(show, REFRESH_MS);
      session.timer.unref();
      entry = session;
    }
    const session = entry;
    session.users++;
    let released = false;
    return {
      ready: session.ready,
      release: () => {
        if (released) return;
        released = true;
        if (--session.users === 0) {
          clearInterval(session.timer);
          this.#typing.delete(to);
        }
      },
    };
  }
}
