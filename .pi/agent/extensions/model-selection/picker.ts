import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  SelectList,
  Spacer,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";

/** The same input, fuzzy matching, list and keybindings used by Pi's model selector. */
export class SearchPicker extends Container {
  readonly input = new Input({ placeholder: "Search…" });
  private readonly body = new Container();
  private list!: SelectList;

  constructor(
    title: string,
    private readonly items: SelectItem[],
    private readonly done: (value: string | undefined) => void,
    private readonly theme: Theme,
    private readonly rows = 10,
    private readonly initial?: string,
    private readonly signal?: AbortSignal,
  ) {
    super();
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    this.addChild(new Text(theme.fg("accent", title), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.input);
    this.addChild(new Spacer(1));
    this.addChild(this.body);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(theme.fg("dim", "Type to search · ↑↓ navigate · Enter select · Esc cancel"), 1, 0),
    );
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    this.input.onSubmit = () => this.list.handleInput("\r");
    this.rebuild();
    signal?.addEventListener("abort", this.cancel, { once: true });

    if (signal?.aborted) this.cancel();
  }

  get focused() {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  private cancel = () => this.done(undefined);

  private rebuild() {
    const selected = this.list?.getSelectedItem()?.value ?? this.initial;
    const query = this.input.getValue();
    const filtered = query
      ? fuzzyFilter(
          this.items,
          query,
          (item) => `${item.value} ${item.label} ${item.description ?? ""}`,
        )
      : this.items;

    this.list = new SelectList(filtered, this.rows, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("muted", text),
      noMatch: (text) => this.theme.fg("muted", text),
    });
    this.list.onSelect = (item) => this.done(item.value);
    this.list.onCancel = this.cancel;

    const index = filtered.findIndex((item) => item.value === selected);

    if (index >= 0) this.list.setSelectedIndex(index);

    this.body.clear();
    this.body.addChild(this.list);
  }

  handleInput(data: string) {
    const bindings = getKeybindings();
    const navigate = [
      "tui.select.up",
      "tui.select.down",
      "tui.select.pageUp",
      "tui.select.pageDown",
      "tui.select.confirm",
      "tui.select.cancel",
    ] as const;

    if (navigate.some((key) => bindings.matches(data, key))) {
      this.list.handleInput(data);

      return;
    }

    this.input.handleInput(data);
    this.rebuild();
  }

  dispose() {
    this.signal?.removeEventListener("abort", this.cancel);
  }
}
