// Bryntum Scheduler view of the collections plan, bundled by esbuild into
// public/build/timeline.js. One row per invoice: the payment term as a bar, the overdue
// stretch, each reminder as a milestone (drag a planned one to reschedule it; the server
// validates the date and rewrites the email for the new day), and the payment.
import { Scheduler, StringHelper } from '@bryntum/scheduler';

const enc = (s) => StringHelper.encodeHtml(String(s ?? ''));
const get = (rec, k) => (rec && typeof rec.get === 'function' ? rec.get(k) : rec && rec.data ? rec.data[k] : undefined);

// Calendar days are local dates in the browser; reminders sit at noon so they render in
// the middle of their day column.
function dayStart(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function noon(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
export function toISO(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function mapData(data) {
  const resources = data.resources.map((r) => ({ ...r }));
  const issueByResource = {};
  const events = data.events.map((e) => {
    const out = { ...e };
    if (e.kind === 'term' || e.kind === 'overdue') {
      out.startDate = dayStart(e.startDate);
      out.endDate = dayStart(e.endDate);
      if (e.kind === 'term') issueByResource[e.resourceId] = e.startDate;
    } else {
      out.startDate = noon(e.startDate);
      out.duration = 0;
      delete out.endDate;
    }
    return out;
  });
  for (const r of resources) r.issueDate = issueByResource[r.id];
  return { resources, events };
}

const LABEL = { polite: 'Polite reminder', firm: 'Firm reminder', final: 'Final reminder' };

function tooltip({ eventRecord }) {
  const kind = get(eventRecord, 'kind');
  const name = enc(eventRecord.name);
  const day = enc(eventRecord.startDate.toDateString());
  if (kind === 'reminder') {
    const st = get(eventRecord, 'reminderStatus');
    const subject = get(eventRecord, 'subject');
    return `<div class="owed-tip"><strong>${enc(LABEL[get(eventRecord, 'stage')] || name)}</strong><div>${day} &middot; ${enc(st)}</div>${subject ? `<div class="owed-tip-subject">&ldquo;${enc(subject)}&rdquo;</div>` : ''}${st === 'planned' ? '<div class="owed-tip-hint">Drag to reschedule; the email is rewritten for the new date.</div>' : ''}</div>`;
  }
  if (kind === 'term') return `<div class="owed-tip"><strong>${name}</strong><div>Sent ${enc(eventRecord.startDate.toDateString())}, due ${enc(eventRecord.endDate.toDateString())}</div></div>`;
  return `<div class="owed-tip"><strong>${name}</strong><div>${day}</div></div>`;
}

let scheduler = null;
let handlers = {};
let todayISO = null;

function create(el, data, opts) {
  handlers = opts || {};
  todayISO = data.today;
  const { resources, events } = mapData(data);
  scheduler = new Scheduler({
    appendTo: el,
    startDate: dayStart(data.startDate),
    endDate: dayStart(data.endDate),
    viewPreset: 'weekAndDayLetter',
    visibleDate: { date: dayStart(todayISO), block: 'center' },
    rowHeight: 52,
    barMargin: 11,
    resourceMargin: 11,
    eventStyle: 'tonal',
    // Count milestone labels in the layout so close reminders stack instead of overlapping.
    milestoneLayoutMode: 'estimate',
    milestoneCharWidth: 7,
    zoomOnMouseWheel: false,
    columns: [
      {
        text: 'Invoice',
        field: 'name',
        width: el.clientWidth && el.clientWidth < 600 ? 130 : 200,
        htmlEncode: false,
        renderer: ({ record }) =>
          `<div class="owed-res"><span class="owed-res-name">${enc(record.name)}</span><span class="owed-res-meta">${enc(get(record, 'number'))} &middot; ${enc(get(record, 'amount'))}</span><span class="owed-res-status owed-st-${enc(get(record, 'status'))}">${enc(get(record, 'statusLabel'))}</span></div>`,
      },
    ],
    resources,
    events,
    timeRanges: [{ id: 'today', name: 'Today', startDate: dayStart(todayISO), duration: 1, durationUnit: 'day', cls: 'owed-today' }],
    features: {
      timeRanges: { showCurrentTimeLine: false, showHeaderElements: true },
      eventDrag: {
        constrainDragToResource: true,
        validatorFn: ({ eventRecords, startDate }) => {
          const ev = eventRecords[0];
          if (!ev || get(ev, 'kind') !== 'reminder') return false;
          const iso = toISO(startDate);
          if (iso < todayISO) return { valid: false, message: 'Not in the past' };
          const issue = get(ev.resource, 'issueDate');
          if (issue && iso <= issue) return { valid: false, message: 'Must come after the invoice was sent' };
          return { valid: true, message: iso };
        },
      },
      eventResize: false,
      eventEdit: false,
      eventMenu: false,
      scheduleMenu: false,
      cellMenu: false,
      headerMenu: false,
      eventDragCreate: false,
      scheduleTooltip: false,
      eventTooltip: { template: tooltip },
    },
    eventRenderer({ eventRecord, renderData }) {
      const kind = get(eventRecord, 'kind');
      const cls = renderData.cls;
      if (cls && typeof cls.add === 'function') cls.add(`owed-${kind}`);
      if (kind === 'reminder' && cls && typeof cls.add === 'function') {
        cls.add(`owed-${get(eventRecord, 'reminderStatus')}`);
        cls.add(`owed-stage-${get(eventRecord, 'stage')}`);
      }
      return enc(eventRecord.name);
    },
    listeners: {
      eventDrop({ eventRecords }) {
        const ev = eventRecords[0];
        if (ev && handlers.onReschedule) handlers.onReschedule(String(ev.id), toISO(ev.startDate));
      },
    },
  });
  centerOnToday();
}

function centerOnToday() {
  // After layout, so the viewport width is known.
  requestAnimationFrame(() => {
    if (scheduler && todayISO) scheduler.scrollToDate(dayStart(todayISO), { block: 'center', animate: false }).catch(() => {});
  });
}

function update(data) {
  if (!scheduler) return;
  todayISO = data.today;
  const { resources, events } = mapData(data);
  const spanChanged = scheduler.startDate.getTime() !== dayStart(data.startDate).getTime();
  if (spanChanged || scheduler.endDate.getTime() !== dayStart(data.endDate).getTime()) scheduler.setTimeSpan(dayStart(data.startDate), dayStart(data.endDate));
  scheduler.resources = resources;
  scheduler.events = events;
  if (spanChanged) centerOnToday();
}

window.OwedTimeline = {
  mount(el, data, opts) {
    if (scheduler) {
      update(data);
      return;
    }
    create(el, data, opts);
  },
  update,
  get instance() {
    return scheduler;
  },
};
window.dispatchEvent(new Event('owed:timeline-ready'));
