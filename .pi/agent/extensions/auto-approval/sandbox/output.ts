import { StringDecoder } from "node:string_decoder";

/** Decode whole UTF-8 characters while enforcing the limit on received bytes. */
export class BoundedOutput {
  private decoder = new StringDecoder("utf8");
  private text = "";
  private bytes = 0;

  constructor(private limit: number) {}

  append(chunk: Buffer) {
    if (this.bytes + chunk.length > this.limit) throw new Error("Executor output limit exceeded");

    this.bytes += chunk.length;
    this.text += this.decoder.write(chunk);
  }

  finish(): string {
    this.text += this.decoder.end();

    return this.text;
  }
}
