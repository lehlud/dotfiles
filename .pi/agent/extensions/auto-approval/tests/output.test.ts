import { expect, test } from "bun:test";
import { BoundedOutput } from "../sandbox/output.ts";

test("executor output keeps multibyte characters intact across arbitrary pipe boundaries", () => {
  const text = JSON.stringify({ content: [{ type: "text", text: "漢🙂 café".repeat(100) }] });
  const bytes = Buffer.from(text);
  const output = new BoundedOutput(bytes.length);

  for (let offset = 0; offset < bytes.length; offset += 2)
    output.append(bytes.subarray(offset, offset + 2));

  expect(output.finish()).toBe(text);
  expect(JSON.parse(output.finish()).content[0].text).toBe("漢🙂 café".repeat(100));
});

test("the output limit counts bytes and excludes an overflowing chunk before accumulation", () => {
  const output = new BoundedOutput(4);

  output.append(Buffer.from("a"));
  output.append(Buffer.from("漢"));
  expect(() => output.append(Buffer.from("b"))).toThrow("Executor output limit exceeded");
  expect(output.finish()).toBe("a漢");
});
