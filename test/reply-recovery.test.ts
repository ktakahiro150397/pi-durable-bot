import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { agentRequests, lastUser, startFakeModel } from "./support/fake-model.ts";
import { TestGateway } from "./support/gateway.ts";

it("recovers an unsent local DM once and keeps the original destination", async () => {
  const model = await startFakeModel((request) =>
    lastUser(request).startsWith("[Pots reply retry]")
      ? { call: { name: "send", arguments: { to: "terminal:#wrong", text: "Recovered answer." } } }
      : { text: "Draft answer." },
  );
  const gateway = new TestGateway({ model, terminal: true, settings: { autoMemory: false } });
  const models = join(gateway.home, "pi", "models.json");
  const definition = join(gateway.botDir, "bot.json");
  writeFileSync(models, readFileSync(models, "utf8").replace('"fake": {', '"omlx-local": {'));
  writeFileSync(definition, readFileSync(definition, "utf8").replace("fake/coworker", "omlx-local/coworker"));
  try {
    await gateway.start();
    const reply = await gateway.run(["chat", "--message", "Short question", "--timeout", "8"]);
    expect(reply.status).toBe(0);
    expect(reply.stdout.match(/Recovered answer\./g)).toHaveLength(1);
    const [draft, retry, ...extra] = agentRequests(model);
    expect(lastUser(draft!)).toContain("Short question");
    expect(lastUser(retry!)).toContain("Draft answer.");
    expect(retry!.tools).toEqual(["send"]);
    expect(extra).toEqual([]);
    expect(gateway.query("SELECT to_address FROM gw_outbox")).toEqual([{ to_address: expect.stringMatching(/^terminal:#dm-/) }]);
  } finally {
    await gateway.dispose();
    await model.close();
  }
});
