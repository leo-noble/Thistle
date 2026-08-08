# Third-party notices

## Claude Counter

Thistle's usage reporting is derived from Claude Counter — specifically
the page-context bridge that reads `/api/organizations/<id>/usage` with the
page's own session, the `fetch` wrapper that observes `message_limit` events on
Claude's SSE stream, and the shape of both payloads (`five_hour` / `seven_day`
windows; `windows['5h']` / `windows['7d']` on the stream, where utilization is
0–1 rather than 0–100).

Claude Counter is distributed under the MIT License:

```
MIT License

Copyright (c) 2025 Claude Counter contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
