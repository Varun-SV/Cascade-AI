// ─────────────────────────────────────────────
//  Cascade AI — PowerPoint animation
// ─────────────────────────────────────────────
//
//  pptxgenjs cannot emit animations. Not "does not by default" — there is no
//  `p:timing`, `animEffect` or `p:transition` anywhere in its output, because
//  the library models shapes and never models the timeline that reveals them.
//  A deck it produces appears all at once, every slide, forever.
//
//  A .pptx is a ZIP of OOXML parts, so the timeline can be added afterwards:
//  each slide part gets a `<p:transition>` and a `<p:timing>` tree, and
//  PowerPoint animates a deck it would otherwise have shown flat. Everything
//  here is written against ECMA-376 Part 1 §19.5 and is deliberately
//  conservative — a malformed timing tree does not degrade, it makes PowerPoint
//  declare the file corrupt and refuse to open it at all.

import JSZip from 'jszip';

/** How a deck reveals itself. */
export interface AnimationScheme {
  /** Slide-to-slide transition. 'none' writes no `p:transition` at all. */
  transition: 'none' | 'fade' | 'push' | 'wipe' | 'split';
  /** How a slide's own shapes arrive. 'none' writes no `p:timing` at all. */
  entrance: 'none' | 'fade' | 'appear' | 'fly';
  /**
   * Whether shapes arrive on their own or wait for a click.
   *
   * Auto suits a deck that plays unattended; click suits a person presenting
   * and is what PowerPoint's own defaults do, so it is the default here.
   */
  advance: 'click' | 'auto';
  /** Entrance duration, milliseconds. Ignored when `entrance` is 'none'. */
  durationMs: number;
}

export const DEFAULT_ANIMATION: AnimationScheme = {
  transition: 'fade',
  entrance: 'fade',
  advance: 'click',
  durationMs: 500,
};

/** `p:transition` child element for each named transition. */
const TRANSITION_TAG: Record<Exclude<AnimationScheme['transition'], 'none'>, string> = {
  fade: '<p:fade/>',
  push: '<p:push dir="u"/>',
  wipe: '<p:wipe dir="d"/>',
  split: '<p:split orient="horz" dir="out"/>',
};

/**
 * presetID / filter pairs, from the preset animation table in §19.5.
 *
 * The presetID is what PowerPoint's own UI shows as the effect name; the filter
 * is what actually renders. Both are written because a reader that recognises
 * neither still gets a shape set visible by the `p:set`, which is why the set
 * is always emitted alongside the effect.
 */
const ENTRANCE: Record<Exclude<AnimationScheme['entrance'], 'none'>, { presetId: number; filter: string }> = {
  fade: { presetId: 10, filter: 'fade' },
  appear: { presetId: 1, filter: 'appear' },
  // `slide`, not `wipe`. The presetId only labels the effect in PowerPoint's
  // UI; the filter is what renders it. `wipe(up)` reveals the shape in place
  // from the bottom edge, which is a Wipe — so a deck asking for Fly In got a
  // wipe wearing the Fly In name. `slide(fromBottom)` moves the shape onto the
  // slide, which is what Fly In means and what PowerPoint's own preset emits.
  fly: { presetId: 2, filter: 'slide(fromBottom)' },
};

/**
 * Give every shape on a slide a unique id, returning the animatable ones.
 *
 * This is not defensive tidying. pptxgenjs assigns `p:cNvPr/@id` per shape
 * KIND rather than per slide, so a slide holding two text boxes and a table
 * emits id=2 twice — once for "Text 0" and once for "Table 0". Animations
 * address shapes by `spTgt/@spid`, so on unrenumbered output an animation
 * aimed at id=2 is ambiguous: PowerPoint picks one, and which one is not
 * something to rely on. Renumbering first is what makes targeting mean
 * anything.
 *
 * The first `p:cNvPr` in a slide belongs to the shape tree itself and is not
 * an animatable shape, so it is skipped.
 */
export function renumberShapes(slideXml: string): { xml: string; shapeIds: number[] } {
  let next = 1;
  const ids: number[] = [];
  const xml = slideXml.replace(
    /<p:cNvPr id="(\d+)" name="([^"]*)"/g,
    (_m, _id: string, name: string) => {
      next += 1;
      ids.push(next);
      return `<p:cNvPr id="${next}" name="${name}"`;
    },
  );
  return { xml, shapeIds: ids.slice(1) };
}

/** One entrance step for one shape. */
function entranceStep(
  spid: number,
  index: number,
  scheme: AnimationScheme,
  nextId: () => number,
): string {
  const { presetId, filter } = ENTRANCE[scheme.entrance as Exclude<AnimationScheme['entrance'], 'none'>];
  // EVERY step waits when the deck advances on click — that is what "on click"
  // means to a presenter and what PowerPoint's own builds do. Gating only the
  // first step made one click reveal the whole slide, which is `auto` with an
  // extra keypress rather than a build.
  const waitsForClick = scheme.advance === 'click';
  const nodeType = waitsForClick ? 'clickEffect' : 'afterEffect';
  void index;
  const stepId = nextId();
  const setId = nextId();
  const effectId = nextId();
  return (
    `<p:par><p:cTn id="${stepId}" fill="hold">`
    + `<p:stCondLst><p:cond delay="${waitsForClick ? 'indefinite' : '0'}"/></p:stCondLst>`
    + '<p:childTnLst>'
    + `<p:par><p:cTn id="${nextId()}" presetID="${presetId}" presetClass="entr" presetSubtype="0"`
    + ` fill="hold" grpId="0" nodeType="${nodeType}">`
    + '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>'
    // The set is what actually makes the shape visible; the effect only styles
    // its arrival. A reader that ignores the effect still shows the shape.
    + `<p:set><p:cBhvr><p:cTn id="${setId}" dur="1" fill="hold">`
    + '<p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>'
    + `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`
    + '<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>'
    + '</p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>'
    + `<p:animEffect transition="in" filter="${filter}"><p:cBhvr>`
    + `<p:cTn id="${effectId}" dur="${Math.max(1, Math.round(scheme.durationMs))}"/>`
    + `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`
    + '</p:cBhvr></p:animEffect>'
    + '</p:childTnLst></p:cTn></p:par>'
    + '</p:childTnLst></p:cTn></p:par>'
  );
}

/** The `p:timing` tree revealing `spids` in order. */
export function timingXml(spids: number[], scheme: AnimationScheme): string {
  if (scheme.entrance === 'none' || spids.length === 0) return '';
  // Ids 1 and 2 are the timeline root and the main sequence by convention;
  // everything else counts up from there and must be unique within the slide.
  let counter = 2;
  const nextId = () => (counter += 1);
  const steps = spids.map((spid, i) => entranceStep(spid, i, scheme, nextId)).join('');
  return (
    '<p:timing><p:tnLst><p:par>'
    + '<p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
    + '<p:seq concurrent="1" nextAc="seek">'
    + '<p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>'
    + steps
    + '</p:childTnLst></p:cTn>'
    + '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
    + '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>'
    + '</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
  );
}

/** The `p:transition` element, or '' when there is no transition. */
export function transitionXml(scheme: AnimationScheme): string {
  if (scheme.transition === 'none') return '';
  return `<p:transition spd="med">${TRANSITION_TAG[scheme.transition]}</p:transition>`;
}

/**
 * Add transitions and entrance animations to one slide part.
 *
 * Element order inside `p:sld` is fixed by the schema — `cSld`, `clrMapOvr`,
 * `transition`, `timing` — and PowerPoint enforces it, so both are inserted
 * immediately before `</p:sld>` where `clrMapOvr` already sits above them.
 * A slide that somehow already carries timing is left alone rather than given
 * a second, conflicting tree.
 */
export function animateSlideXml(slideXml: string, scheme: AnimationScheme): string {
  if (slideXml.includes('<p:timing') || !slideXml.includes('</p:sld>')) return slideXml;
  // Renumbering happens even with no animation to add. Duplicate cNvPr ids are
  // invalid OOXML in their own right — pptxgenjs numbers per shape KIND, so a
  // slide with a text box and a table emits id=2 twice — and every reference to
  // a shape (selection, comments, a later edit) resolves through that id. It
  // was only ever done here because animation is what made it visible.
  const { xml, shapeIds } = renumberShapes(slideXml);
  const addition = transitionXml(scheme) + timingXml(shapeIds, scheme);
  if (!addition) return xml;
  return xml.replace('</p:sld>', `${addition}</p:sld>`);
}

/**
 * Add animations to every slide of a rendered `.pptx`.
 *
 * Takes and returns the whole package because the unit of work is the ZIP:
 * slide parts are found by path rather than by asking pptxgenjs, which has no
 * API for reaching them.
 */
export async function animatePptx(bytes: Uint8Array, scheme: AnimationScheme): Promise<Uint8Array> {
  // No early return for `animation: none`: the shape-id fix above applies to
  // every deck, animated or not.
  try {
    const zip = await JSZip.loadAsync(bytes);
    const slidePaths = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    if (slidePaths.length === 0) return bytes;
    for (const path of slidePaths) {
      const xml = await zip.file(path)!.async('string');
      zip.file(path, animateSlideXml(xml, scheme));
    }
    // Same deflate the renderers use, and uint8array so this behaves identically
    // in the browser, under jsdom and in plain Node.
    return await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  } catch {
    // Anything unreadable here is the ANIMATION step failing, not the deck.
    // Handing back the original bytes costs the animation; throwing would cost
    // the whole export — and the deck itself was fine before we opened it.
    return bytes;
  }
}
