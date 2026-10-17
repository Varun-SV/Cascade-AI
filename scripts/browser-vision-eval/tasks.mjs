// ─────────────────────────────────────────────
//  Cascade AI — Browser vision test: the tasks
// ─────────────────────────────────────────────
//
//  Ten small tasks on a local site, each aimed at something the old
//  text-and-selector view handled badly. A task is done when its page reports
//  it (`check.done`, sent by the page itself) or when the run's answer matches
//  (`check.answer`).
//
//  `solve` is a scripted solution, used by `run.mjs --check` to prove each
//  task can be done through browser_control at all — so a model that fails a
//  task failed it, rather than met a broken page. Steps name controls by their
//  label in the page view, the way a model reads them.

export const TASKS = [
  {
    id: 'saved',
    page: 'saved.html',
    tests: 'an icon-only button, known only by its accessible name',
    prompt: 'Save Ember & Oak to my saved places.',
    check: { done: 'saved' },
    solve: [{ action: 'click', label: 'button "Save Ember & Oak"' }],
  },
  {
    id: 'booking',
    page: 'booking.html',
    tests: 'a form with a select, a calendar of plain clickable cells and radio buttons',
    prompt: 'Request a booking for 4 people on 14 October at 8:45 pm, under the name Asha.',
    check: { done: 'booking' },
    solve: [
      { action: 'fill', label: 'textbox "Name"', value: 'Asha' },
      { action: 'select_option', label: 'combobox "Party size"', value: '4' },
      { action: 'click', label: 'clickable "14"' },
      { action: 'click', label: 'radio "8:45 pm"' },
      { action: 'click', label: 'button "Request booking"' },
    ],
  },
  {
    id: 'plans',
    page: 'plans.html',
    tests: 'a layout whose order on screen differs from the order in the page',
    prompt: 'Which plan appears in the middle of the three, as the page is shown on screen? Answer with the plan name only.',
    check: { answer: /\bteam\b/i },
    solve: [{ action: 'extract_text' }],
  },
  {
    id: 'cookies',
    page: 'cookies.html',
    tests: 'a modal dialog in front of the page',
    prompt: 'Open the Offers page.',
    check: { done: 'cookies' },
    solve: [
      { action: 'click', label: 'button "Accept all"' },
      { action: 'click', label: 'link "Offers"' },
    ],
  },
  {
    id: 'newsletter',
    page: 'newsletter.html',
    tests: 'a form inside a shadow root',
    prompt: 'Subscribe to the newsletter with the email asha@example.com.',
    check: { done: 'newsletter' },
    solve: [
      { action: 'fill', label: 'textbox "Your email"', value: 'asha@example.com' },
      { action: 'click', label: 'button "Subscribe"' },
    ],
  },
  {
    id: 'promo',
    page: 'promo.html',
    tests: 'a form inside an iframe',
    prompt: 'Apply the promo code SAVE10 to this order.',
    check: { done: 'promo' },
    solve: [
      { action: 'fill', label: 'textbox "Promo code"', value: 'SAVE10' },
      { action: 'click', label: 'button "Apply"' },
    ],
  },
  {
    id: 'list',
    page: 'list.html',
    tests: 'a long list where the button needed is far down and shares its name with forty others',
    prompt: 'Hold the 9:15 pm slot at Pepper.',
    check: { done: 'list' },
    solve: [{ action: 'click', label: 'button "9:15 pm"', after: 'heading "Pepper"', scroll: true }],
  },
  {
    id: 'reviews',
    page: 'reviews.html',
    tests: 'tabs, with the answer hidden until one is opened',
    prompt: 'How many stars did Priya give in her review? Answer with the number only.',
    check: { answer: /\b5\b/ },
    solve: [{ action: 'click', label: 'tab "Reviews"' }, { action: 'extract_text' }],
  },
  {
    id: 'terms',
    page: 'terms.html',
    tests: 'a button disabled until something else is done first',
    prompt: 'Accept the terms and continue.',
    check: { done: 'terms' },
    solve: [
      { action: 'click', label: 'checkbox "I accept the terms"' },
      { action: 'click', label: 'button "Continue"' },
    ],
  },
  {
    id: 'menu',
    page: 'home.html',
    tests: 'an answer on another page of the site',
    prompt: 'How much is the mushroom risotto? Answer with the price only.',
    check: { answer: /640/ },
    solve: [{ action: 'click', label: 'link "Menu"' }, { action: 'extract_text' }],
  },
];
