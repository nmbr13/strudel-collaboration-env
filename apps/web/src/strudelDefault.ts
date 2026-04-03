/** Shipped as the collaborative editor's empty-doc seed; keep in sync with CollabEditor seeding. */
export const STRUDEL_DEFAULT_SNIPPET = `setcpm(128/4)

scale = ("d:minor")

let drums = stack(
  s().sound("RolandTR909")
)

let bass = stack(

)

let synth_pads = stack(

)

let synth_lead = stack(

)

let music = stack(
  drums.gain(1),
  bass.gain(1),
  synth_pads.gain(1),
  synth_lead.gain(1)
)

music`;
