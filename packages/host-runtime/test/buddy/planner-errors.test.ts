import { expect, it } from "vitest";
import { BuddyPlanner } from "../../src/buddy/planner.js";

it("preserves the upstream validation error when planning fails", async () => {
  const message = "[input[9].name] [invalid_string] string does not match pattern";
  const planner = new BuddyPlanner(
    async (method) => {
      if (method === "thread/start") return { result: { thread: { id: "planner" } } };
      if (method === "turn/start") {
        planner.observe({
          method: "turn/completed",
          params: {
            threadId: "planner",
            turn: { id: "plan-turn", status: "failed", error: { message } },
          },
        });
        return { result: { turn: { id: "plan-turn" } } };
      }
      return { result: {} };
    },
    async () => undefined,
    () => undefined,
  );
  await expect(
    planner.plan({
      model: "planner",
      cwd: "/tmp",
      task: [],
      context: "",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(message);
});
