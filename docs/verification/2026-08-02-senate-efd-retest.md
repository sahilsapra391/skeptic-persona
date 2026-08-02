# Senate eFD, re-tested from a residential connection (2026-08-02T00:4xZ)

**The recorded reason for parking the Senate lane does not survive re-testing,
and the honest unlock it recommended would not have worked.**

The p4 session flagged the relay's Senate leg failing and named the leading
hypothesis from the workflow's own comment: eFD blocks GitHub's Azure runner
IP class, so the fix is architectural. This re-tests that.

## What was recorded

From p4-00: *"eFD search POST 503s GitHub Azure runners with a bot-mitigation
page, invariant to session handling; honest unlock = owner-run residential
courier to /ingest."*

## What actually happens

Same three-step handshake, same declared UA (`Skeptic Wire admin@spechawk.ai`),
run from a **residential** connection — i.e. exactly the courier that was
recommended as the unlock:

```
home=200  bytes=11880  csrfmiddlewaretoken=yes
agree=411 -> https://efdsearch.senate.gov/search/
search=503  bytes=4869
```

**Byte-for-byte the runner's failure.** So it is not an Azure IP class, and
the recommended unlock would have hit the same wall on day one.

## The 411 is a curl artifact, not a finding

Running the agreement POST **without** `-L`:

```
HTTP/1.1 302 Moved Temporarily
Location: /search/
Set-Cookie: sessionid=eyJzZWFyY2hfYWdyZWVtZW50Ijp0cnVlfQ:...; HttpOnly; Secure
```

The base64 payload decodes to `{"search_agreement": true}`. **The agreement is
accepted and the session is real.** The 411 was curl following the 302 as a
POST with no body, and it was never evidence of anything.

Continuing with that session:

| request | result |
|---|---|
| `GET /search/home/` | **200** |
| `POST /search/home/` (agreement) | **302**, valid `sessionid` |
| `GET /search/` (the authenticated search page) | **200** |
| `POST /search/report/data/` (the XHR data endpoint) | **503** |

Everything works up to and including the authenticated page. Only the data
endpoint fails.

## And the 503 body is not a block page

Stripped of markup, all 4,869 bytes of it say:

> U.S. Senate: Site Under Maintenance — WEBSITE TEMPORARILY UNAVAILABLE DUE
> TO MAINTENANCE. Normal service will return soon.

No Cloudflare Ray ID. No Akamai or Incapsula reference. No support ID. No
vendor markers of any kind, and the page is branded by the Senate itself. 503
is also the correct status for planned maintenance, where a WAF would more
usually answer 403 or 429.

**"Bot-mitigation page" was a reading, not an observation**, and it became the
premise for parking the lane and for the courier recommendation built on top.

## What this does and does not establish

**Established:** the failure is not IP-class — it reproduces from residential.
The session handshake works. The 411 is noise. The body is a maintenance
notice.

**Not established:** that eFD will serve us when maintenance ends. A
maintenance window is the simplest explanation consistent with every
observation above, and this was run at **00:40Z on a Sunday**, which is when
maintenance is scheduled. It is not proof.

**The test is a weekday retry**, and it is cheap: `workflow_dispatch` with
`lane=senate`. Until then the lane stays parked — parked on "unverified", not
on "IP-blocked", and those imply different next steps. If the endpoint answers
during business hours the lane needs no architecture at all.

## Also corrected: the relay is not failing

Three runs exist, all `workflow_dispatch`, none scheduled:

- **17:18:33Z, main** — a routine dispatch that ran the parked Senate lane
  alongside the working ones. The `inputs.lane == 'senate'` gate that prevents
  exactly this was committed at **17:47:07Z**, 29 minutes later. This run is
  what motivated the gate.
- **17:28Z and 17:30Z, branch** — deliberate `lane=senate` probes. `relay` and
  `house` correctly skipped.

Treasury, House and CFTC all succeeded in the main run. The schedule is
`*/30 13-21 * * 1-5`; it is now Sunday, so no scheduled runs is correct rather
than symptomatic. **Three red entries in the Actions tab, zero broken lanes.**
