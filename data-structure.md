# Timeline Data Structure

A minimal format for events and timelines — from a single event unfolding, to a whole life, to all of human history.

**Version:** 0.1 (locked)
**Schema version:** 1
**Date:** 17 November 2026

## 1. Purpose and scope

This specification defines the data structure for a timeline tool: how a single event is represented, and how a collection of events makes up a timeline.

The same shape must serve three very different scales without modification:

- **An event unfolding** — minutes and seconds, such as a mission, a match, or an incident.
- **A whole life** — days and years, such as a biography.
- **All of human history** — centuries and millennia, including dates before the common era and dates known only approximately.

The format is plain JSON. One timeline is stored in one file.

## 2. Design principles

1. **Minimal by default.** An event requires only three fields: `id`, `title`, and `start`. Every other field is optional and must earn its place.
2. **Time is structured, everything else is text.** Dates are never free-form strings. Titles, descriptions, and labels are plain text.
3. **No presentation in the data.** The data contains no colour, position, lane, zoom level, or visibility flag. A viewer derives all of that.
4. **Flat events, composable timelines.** Events do not contain other events. Larger subjects are handled by linking one timeline from an event in another (section 6).
5. **Forward compatible.** Readers must ignore fields they do not recognise, so a version 2 file does not break a version 1 reader.
6. **One rule for every scale.** If a field is only needed by one of the three uses above, it does not belong in version 1.

## 3. The Timeline object

A timeline is a collection of events plus its own metadata. It is not just an array: it names itself, describes itself, and defines the categories its events may use.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schema_version` | number | Yes | Always `1` in this version of the spec. |
| `id` | string | Yes | Stable identifier, unique among timelines. Other timelines link to it. |
| `title` | string | Yes | Short human-readable name. |
| `description` | string | No | Plain text summary. |
| `categories` | array | No | Controlled vocabulary for this timeline. Each entry is `{ id, label }`. |
| `events` | array | Yes | The events in the timeline. May be empty. File order carries no meaning; display order is derived (section 8). |

Derived values are never stored: range, event count, and ordering are computed from events, so they can never disagree with the data.

## 4. The Event object

An event is one thing that happened, with a time span. A span with no end is an instant.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | Yes | Stable and unique within its timeline, e.g. `apollo-11-landing`. |
| `title` | string | Yes | Short name for the event. |
| `start` | TimePoint | Yes | When the event begins. See section 5. |
| `end` | TimePoint or null | No | When the event ends. Omitted or `null` means the event is an instant. |
| `description` | string | No | Plain text. No markup in version 1. |
| `category` | string | No | One category id from the timeline's `categories`. |
| `tags` | string array | No | Free-form labels for filtering. |
| `detail_timeline_id` | string or null | No | Another timeline that expands this event. See section 6. |
| `sources` | array | No | Citations for the event, each `{ label, url }`. See section 7. |
| `extensions` | object | No | Escape hatch for experimental fields. Readers ignore it. |

## 5. TimePoint — representing time

Time is the hardest part of this format, because one field must hold a launch measured in seconds and an empire measured in centuries. A TimePoint therefore separates the value from how precisely it is known:

```json
{ "at": "1969-07-20T20:17:40Z", "precision": "second" }
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `at` | string | Yes | ISO 8601 date or datetime, normalised to the start of the unit named by `precision`. |
| `precision` | string | Yes | One of: `second`, `minute`, `hour`, `day`, `month`, `year`, `decade`, `century`, `millennium`. |
| `circa` | boolean | No | True when the date is approximate. Optional: when omitted, it is assumed to be false. Most events will not carry this field at all. |

### Rules

- **Normalisation.** `at` is always the start of its unit. A year-only date is written `"1066-01-01"` with `precision: "year"`; a century is written as its first year with `precision: "century"`.
- **Dates before the common era** use a negative year, zero-padded to six digits. 44 BCE is `"-0044-03-15"`. The 3rd century BCE, approximately, is `{ "at": "-0300-01-01", "precision": "century", "circa": true }`.
- **Precision is not decoration.** A viewer should show a year-precision date as a year, not as 1 January, and may draw a circa date faded or with a tilde. Sorting still uses `at`.
- **Instants and spans.** An event with no end is an instant at its start precision. An event with an end spans from the start of `start` to the end of the unit named by `end.precision`.

**Why not separate year, month, and day fields?** A single ISO value sorts correctly as a string at every precision, is understood by every JSON tool, and needs no special handling for BCE years beyond the sign. Splitting it into integers would make each of those harder.

## 6. Linking timelines instead of nesting events

Version 1 has **no `parent_id`** and no sub-events. An event is always a flat entry in one timeline. Nesting — a war containing a battle, a life containing a career — is expressed by linking a whole timeline from an event:

```json
{
  "id": "wwii",
  "title": "Second World War",
  "start": { "at": "1939-09-01", "precision": "day" },
  "end": { "at": "1945-09-02", "precision": "day" },
  "detail_timeline_id": "wwii"
}
```

The linked timeline is an ordinary timeline file with its own id, categories, and events. An event inside it, such as D-Day, may in turn carry a `detail_timeline_id` pointing to a third timeline.

- **Reusable.** The same detail timeline may be linked from more than one event, and every timeline stands on its own.
- **Kept separate from sources.** `detail_timeline_id` is a drill-down into more events. `sources` is a citation for this event. The two are never interchanged.
- **Missing links do not break anything.** If the linked timeline cannot be found, a viewer renders the event as a plain event, with no link.
- **Cycles are allowed.** Timeline A may link to B, and B back to A. Navigation is user-driven, so a viewer only needs a breadcrumb or back path.

## 7. Categories, tags, and sources

### Categories

Categories are the controlled vocabulary of a single timeline, declared in its `categories` array as `{ id, label }` pairs; an event's `category` holds one such id. A history timeline might define `empire` and `invention`; a life, `family` and `work`. There is no global list in version 1.

### Tags

Tags are the opposite: free-form strings on an event, for filtering, with no declaration required. If a tag needs a label or a definition, it should be a category instead.

### Sources

Sources are part of version 1, because a history timeline without citations is hard to trust:

```json
"sources": [
  { "label": "Apollo 11 mission report", "url": "https://example.org/apollo-11-report" }
]
```

`label` is required for each source; `url` may be omitted for a book or offline reference.

## 8. Ordering and validation

### Ordering

Events are sorted by `start.at`, then by `end.at` (instants first), then by `title`. This order is total and deterministic: two readers given the same file always produce the same sequence.

### Validation rules

- `schema_version` is present and equals 1.
- Every event `id` is unique within its timeline.
- If `end` is present, it is not earlier than `start`.
- If an event has a `category`, that id exists in the timeline's `categories`.
- Every TimePoint has a valid ISO 8601 `at` value and a `precision` from the list in section 5.
- `detail_timeline_id` and `sources` are never validation errors when their targets are missing; they degrade as described in sections 6 and 7.
- Unknown fields are ignored, not rejected.

## 9. Examples at three scales

### An event unfolding — Apollo 11, at second precision

```json
{
  "schema_version": 1,
  "id": "apollo-11",
  "title": "Apollo 11",
  "categories": [{ "id": "flight", "label": "Flight" }],
  "events": [
    {
      "id": "launch",
      "title": "Launch from Kennedy",
      "start": { "at": "1969-07-16T13:32:00Z", "precision": "second" },
      "category": "flight",
      "description": "Saturn V lifts off."
    },
    {
      "id": "landing",
      "title": "Lunar landing",
      "start": { "at": "1969-07-20T20:17:40Z", "precision": "second" },
      "category": "flight"
    }
  ]
}
```

Note what is absent: no `circa`, because these dates are exact; no `end`, because these events are instants.

### A whole life — spans, at day and year precision

```json
{
  "id": "first-job",
  "title": "First job, harbour bookshop",
  "start": { "at": "1988-06-01", "precision": "day" },
  "end": { "at": "1991-08-31", "precision": "day" },
  "category": "work",
  "tags": ["part-time"]
}
```

### All of human history — BCE and approximate dates

```json
{
  "id": "assassination-of-caesar",
  "title": "Assassination of Julius Caesar",
  "start": { "at": "-0044-03-15", "precision": "day" },
  "category": "rome",
  "sources": [{ "label": "Plutarch, Life of Caesar" }]
}
```

```json
{
  "id": "bronze-age-collapse",
  "title": "Late Bronze Age collapse",
  "start": { "at": "-1200-01-01", "precision": "century", "circa": true },
  "category": "near-east"
}
```

The three examples use exactly the same fields. Only the precision — and, where the date is genuinely uncertain, `circa` — changes.

## 10. Versioning and extensibility

Every file declares `schema_version`. This spec defines version 1. Readers must ignore unknown fields at every level — timeline, event, TimePoint, and source. A future version may add optional fields freely. Changing the meaning of an existing field, or making an optional field required, requires a new `schema_version`. Experimental fields belong inside `extensions`, never as new top-level names, until they are adopted into the spec.

## 11. Deliberately excluded from version 1

Each of the following was considered and left out. None will be added until at least two of the three uses in section 1 need it:

- **Sub-events and `parent_id`** — replaced by `detail_timeline_id` (section 6).
- **Media** — no images, audio, or video attachments on events.
- **Location** — no coordinates or place objects.
- **People** — no structured participants; names belong in titles and descriptions for now.
- **Recurrence** — no repeating events.
- **Presentation** — no colour, icon, lane, or ordering hints in the data.
- **Rich text** — descriptions are plain text only.
