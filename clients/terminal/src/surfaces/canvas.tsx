"use client";
import { registerCommand, registerTab } from "../contributions";
import { LayoutServiceId, type TabDescriptor } from "../workbench/layout";
import { MeetingCanvasView } from "../canvas/MeetingCanvasView";

function canvasTab(): TabDescriptor {
  return { id: "meeting-canvas", title: "Toplantı tuvali", kind: "canvas", params: {}, context: null };
}

function CanvasTab() {
  return <MeetingCanvasView />;
}

registerTab("canvas", CanvasTab);
registerCommand({
  id: "meeting.canvas.open",
  title: "Toplantı tuvalini aç",
  run: ({ container }) => container.get(LayoutServiceId).openTab(canvasTab()),
});
