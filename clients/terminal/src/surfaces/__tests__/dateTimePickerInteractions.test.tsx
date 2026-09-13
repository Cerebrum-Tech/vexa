import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateTimePicker } from "../../ui-kit/DateTimePicker";
const initial = new Date(2026, 8, 11, 9, 0).toISOString();
const saved = vi.fn(), changed = vi.fn();
function Form() {
  const [date, setDate] = useState(initial);
  return <form onSubmit={(event) => { event.preventDefault(); saved(date); }}>
    <DateTimePicker value={date} onChange={(next) => { changed(next); setDate(next); }} />
    <input aria-label="Başlık" /><button type="submit">Planla</button><output data-testid="selected">{date}</output>
  </form>;
}
function openAndType(time: string) {
  // The trigger is first; the separate accessibility assertion checks its stable label.
  fireEvent.click(screen.getAllByRole("button")[0]);
  const input = screen.getByRole("textbox", { name: "Saati yazın" }); input.focus();
  fireEvent.change(input, { target: { value: time } }); return input;
}
const selected = () => new Date(screen.getByTestId("selected").textContent!);
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 10, 10)); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("DateTimePicker interaction commits", () => {
  it("commits the latest valid typed time before outside mousedown closes the input", () => {
    render(<Form />); openAndType("17:35");
    fireEvent.mouseDown(screen.getByLabelText("Başlık"));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(selected().getHours()).toBe(17); expect(selected().getMinutes()).toBe(35);
    fireEvent.click(screen.getByRole("button", { name: "Planla" })); expect(saved).toHaveBeenCalledWith(new Date(2026, 8, 11, 17, 35).toISOString());
  });
  it("commits before a direct outside submit click, including keyboard-generated clicks", () => {
    render(<Form />); openAndType("17:35"); fireEvent.click(screen.getByRole("button", { name: "Planla" }));
    expect(saved).toHaveBeenCalledWith(new Date(2026, 8, 11, 17, 35).toISOString());
  });
  it("keeps invalid text open and blocks outside pointer/mouse/click and form submission", () => {
    render(<Form />); const input = openAndType("25:70"); const button = screen.getByRole("button", { name: "Planla" });
    fireEvent.pointerDown(button); fireEvent.mouseDown(button); fireEvent.click(button); fireEvent.submit(button.closest("form")!);
    expect(saved).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); expect(screen.getByRole("dialog")).toBeTruthy(); expect(screen.getByRole("alert")).toBeTruthy(); expect(input.getAttribute("aria-invalid")).toBe("true");
  });
  it("cancels the typed draft with Escape without a blur commit", () => {
    render(<Form />); const input = openAndType("17:35"); fireEvent.keyDown(input, { key: "Escape" }); fireEvent.blur(input);
    expect(screen.queryByRole("dialog")).toBeNull(); expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button")[0]); expect((screen.getByRole("textbox", { name: "Saati yazın" }) as HTMLInputElement).value).toBe("09:00");
  });
  it("uses the typed time when choosing a different day without requiring blur first", () => {
    render(<Form />); openAndType("17:35"); fireEvent.click(screen.getByRole("button", { name: "12" }));
    expect(selected().getDate()).toBe(12); expect(selected().getHours()).toBe(17); expect(selected().getMinutes()).toBe(35);
  });
  it("keeps the browsed month when typed-time blur precedes a calendar-day click", () => {
    render(<Form />);
    fireEvent.click(screen.getByRole("button", { name: "Tarih ve saat" }));
    fireEvent.click(screen.getByRole("button", { name: "Sonraki ay" }));
    const input = screen.getByRole("textbox", { name: "Saati yazın" });
    input.focus(); fireEvent.change(input, { target: { value: "17:35" } });
    const octoberDay = screen.getByRole("button", { name: "12" });
    fireEvent.mouseDown(octoberDay); fireEvent.blur(input); fireEvent.click(octoberDay);
    expect(selected().toISOString()).toBe(new Date(2026, 9, 12, 17, 35).toISOString());
  });
  it.each(["Yarın 14:00", "14:00"])("lets an explicit %s choice replace the typed draft", (name) => {
    render(<Form />); const input = openAndType("17:35"); const choice = screen.getByRole("button", { name });
    fireEvent.mouseDown(choice); fireEvent.blur(input); fireEvent.click(choice);
    expect(selected().getHours()).toBe(14); expect(selected().getMinutes()).toBe(0); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("labels the trigger and keeps the popup border box within a narrow viewport", () => {
    vi.stubGlobal("innerWidth", 390);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 36, right: 180, width: 144, top: 100, bottom: 132, height: 32, x: 36, y: 100, toJSON: () => ({}) });
    render(<Form />); const trigger = screen.getByRole("button", { name: "Tarih ve saat" }); fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog"); expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.style.boxSizing).toBe("border-box"); expect(dialog.style.width).toBe("358px"); expect(dialog.style.left).toBe("-20px");
    vi.unstubAllGlobals();
  });
});
