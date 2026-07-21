// Loaded as a <script type="module" src="/load-talkinghead.js"> — served
// statically from /public, so webpack never parses or bundles this file or
// the CDN URL inside it.
import { TalkingHead } from "https://cdn.jsdelivr.net/gh/met4citizen/TalkingHead@1.7/modules/talkinghead.mjs";
window.__TalkingHead = TalkingHead;
