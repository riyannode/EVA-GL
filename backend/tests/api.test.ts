import { expect, test } from "bun:test";
import { app } from "../src/index";

const request = () => app.request(new Request("http://localhost/api/evaluations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
}));

test("rate limits repeated evaluation requests", async () => {
  expect((await request()).status).toBe(400);
  expect((await request()).status).toBe(400);
  expect((await request()).status).toBe(400);
  const limited = await request();
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
});
