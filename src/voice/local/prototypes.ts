/**
 * Example phrasings for each intent, used by the local (free, in-browser) tier.
 *
 * Why examples and not the descriptions the hosted model gets: a sentence
 * embedding model is trained to put *similar sentences* near each other, not to
 * decide whether a sentence satisfies a description. Asking MiniLM how close
 * "it's too bright in here" is to "switch the app to a dark colour scheme" is
 * asking it the wrong question; asking how close it is to "turn the lights
 * down" is asking the right one. So each intent is represented by a handful of
 * ways a person might actually say it, and an utterance is classified by its
 * nearest neighbour among them.
 *
 * These deliberately lean on the phrasings tier 1 *cannot* already parse. The
 * grammar has the literal forms covered ("add a box", "dark mode"); what earns
 * its keep here is the oblique stuff — hints, complaints, and requests phrased
 * as observations.
 *
 * Keep every entry short and in the voice of someone talking to a diagram.
 * Long sentences dilute the embedding and blur the intent apart.
 *
 * And never name a thing that could be on someone's canvas. "highlight the
 * intake box" reads like a fine example of `select` and is a trap: it put
 * `select` within 0.02 cosine of `connect` for every sentence that happened to
 * mention a node called Intake, because the model is matching the noun, not the
 * verb. Prototypes describe the act; the canvas supplies the nouns.
 */

export const PROTOTYPES: Readonly<Record<string, readonly string[]>> = {
  add: [
    "add a box",
    "put a new shape on the canvas",
    "we need a step here",
    "there should be a data store in this",
    "can you drop in another node",
    "stick another one on there",
    "this is missing a decision point",
    "chuck a circle down",
  ],
  connect: [
    "connect these two",
    "draw a line from one to the other",
    "join them up",
    "this one should point at that one",
    "wire this one into that one",
    "they need an arrow between them",
    "link the first thing to the second",
  ],
  rename: [
    "rename it",
    "call it something else",
    "change the text on that",
    "that should say checkout instead",
    "the wording on this one is wrong",
    "relabel that box",
  ],
  fill: [
    "make it orange",
    "colour that one in",
    "give it a bit of colour",
    "shade this blue",
    "that should be a different colour",
    "paint it green",
  ],
  delete: [
    "delete that",
    "get rid of it",
    "take that off the canvas",
    "we don't need the storage one",
    "remove this box",
    "bin that node",
    "that one shouldn't be there",
  ],
  select: [
    "select that one",
    "pick that shape",
    "highlight the one on the left",
    "grab that node",
  ],
  duplicate: [
    "duplicate it",
    "make another one of those",
    "copy that box",
    "i need a second one just like it",
  ],
  move: [
    "move it right",
    "shift that over a bit",
    "nudge it up",
    "shove that across",
    "scoot it down a touch",
  ],
  tidy: [
    "tidy up",
    "clean up the layout",
    "this is a mess, sort it out",
    "arrange everything properly",
    "straighten this diagram out",
    "lay it out neatly",
  ],
  undo: [
    "undo that",
    "take that back",
    "revert the last change",
    "that's not what i wanted, go back",
    "scrap what you just did",
    "oops, reverse that",
    "no, not like that",
  ],
  redo: [
    "redo it",
    "put that back",
    "actually i did want that, restore it",
    "bring back what i just undid",
  ],
  clear: [
    "clear the canvas",
    "wipe everything",
    "start over from nothing",
    "delete the whole diagram",
    "empty the board",
  ],
  sample: [
    "load the sample",
    "show me the ready-made example",
    "give me something to start from",
    "i don't want a blank page",
  ],
  export_svg: ["export as svg", "give me a vector file", "download this as an svg"],
  export_png: ["export as png", "save this as an image", "give me a picture of it"],
  save: ["save it to a file", "download a copy", "put this somewhere safe"],
  open: ["open a file", "load a diagram from disk", "import a saved one"],
  theme_dark: [
    "dark mode",
    "switch to the dark theme",
    "it's too bright in here",
    "my eyes hurt",
    "turn the lights down",
    "go darker",
  ],
  theme_light: [
    "light mode",
    "switch to the light theme",
    "it's too dark to see",
    "brighten it up",
    "back to white",
  ],
  zoom_in: ["zoom in", "make everything bigger", "i can't read this, get closer", "magnify it"],
  zoom_out: ["zoom out", "make it smaller", "let me see the whole thing", "pull back a bit"],
  zoom_reset: ["reset the zoom", "back to normal size", "fit it to the screen", "actual size"],
  mode_draw: ["switch to draw mode", "let me draw", "i want to sketch now", "give me the pen"],
  mode_select: [
    "switch to select mode",
    "let me move things around",
    "stop drawing, i want to drag",
    "pointer mode",
  ],
  mode_text: ["text mode", "i want to type a caption", "let me add some text", "give me a text box"],
  mode_write: ["write mode", "let me hand write letters", "i want to print letters by hand"],
  arrows_on: ["turn arrows on", "new lines should have arrowheads", "i want arrows"],
  arrows_off: ["turn arrows off", "plain lines from now on", "no arrowheads please"],
  help: [
    "help",
    "what can i say",
    "show me the shortcuts",
    "what are the commands",
    "i don't know how to use this",
  ],
  // Not a command. Having explicit neighbours for chitchat is worth more than a
  // similarity floor alone: it gives the nearest-neighbour search somewhere
  // correct to land instead of forcing the least-wrong command to win.
  none: [
    "what's the weather like",
    "how are you doing today",
    "hmm",
    "uh, let me think",
    "so anyway, as i was saying",
    "who won the game last night",
    "thanks, that's great",
    "wait, hold on a second",
    "yeah exactly",
    "what did you have for lunch",
  ],
};

/** Flattened (intent, phrase) pairs, in a stable order for batch embedding. */
export const PROTOTYPE_PAIRS: ReadonlyArray<readonly [string, string]> = Object.entries(
  PROTOTYPES,
).flatMap(([intent, phrases]) => phrases.map((p) => [intent, p] as const));
