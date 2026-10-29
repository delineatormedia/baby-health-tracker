// Shared mock content for all three directions. Fake data only.
window.BHT = {
  baby: { name: "Juniper", age: "12 days" },
  feed: { side: "Right", elapsed: "08:42", started: "2:51 AM" },
  events: [
    { t: "2:38", ap: "AM", kind: "Breastfeed", detail: "Left · 14 min", who: "K" },
    { t: "2:05", ap: "AM", kind: "Wet diaper", detail: "", who: "S" },
    { t: "11:50", ap: "PM", kind: "Bottle", detail: "Breast milk · 60 mL · 2.0 oz", who: "S" },
    { t: "11:20", ap: "PM", kind: "Dirty diaper", detail: "Mustard · seedy · M", who: "K", swatch: "#C9A227" },
    { t: "9:30", ap: "PM", kind: "Pump", detail: "45 mL L · 38 mL R", who: "K" },
  ],
  quick: ["Wet", "Dirty", "Mixed", "Bottle", "Breast", "Pump"],
  swatches: {
    normal: [
      { name: "Yellow", c: "#E6C24A" },
      { name: "Mustard", c: "#C9A227" },
      { name: "Green", c: "#6F7F2E" },
      { name: "Brown", c: "#7A5230" },
      { name: "Black", c: "#2A2420", note: "first days" },
    ],
    flag: [
      { name: "Pale yellow", c: "#EFE6B8" },
      { name: "Clay", c: "#BDB3A1" },
      { name: "White", c: "#F4F1EA" },
      { name: "Red", c: "#9E2A22" },
    ],
  },
};
