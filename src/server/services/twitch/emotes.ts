import { TextEvent } from "@/types";
import type { ApiClient, HelixEmote } from "@twurple/api";
import {
  Load_FFZ_CHANNEL,
  Load_FFZ_GLOBAL,
  Load_BTTV_CHANNEL,
  Load_BTTV_GLOBAL,
  Load_7TV_CHANNEL,
  Load_7TV_GLOBAL,
} from "./emote_loaders";
import { subscribeKey } from "valtio/utils";

class TwitchEmotesApi {
  constructor() {
    subscribeKey(
      window.ApiServer.state.services.twitch.data,
      "emotesReplacements",
      (_) => {
        this.updateReplacementsCache();
      }
    );
  }
  dictionary: Record<string, string> = {};
  dictionaryLowerCase: Record<string, string> = {};
  dictionaryReplacementsLowerCase: Record<string, string> = {};

  get #emoteReplacements() {
    return window.ApiServer.state.services.twitch.data.emotesReplacements;
  }

  // to lowercase
  updateReplacementsCache() {
    this.dictionaryReplacementsLowerCase = Object.fromEntries(
      Object.entries(this.#emoteReplacements).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ])
    );
  }

  // Returns { [character index of word start]: emote url } for every word that
  // is an emote. Only whole words are matched, never parts of words.
  scanForEmotes(sentence: string): Record<number, string> {
    const enabled = window.ApiServer.state.services.twitch.data.emotesEnableReplacements;
    if (!sentence || !enabled) return {};

    const isSensitive = window.ApiServer.state.services.twitch.data.emotesCaseSensitive;
    const dictionary = isSensitive ? this.dictionary : this.dictionaryLowerCase;
    const replacements = isSensitive ? this.#emoteReplacements : this.dictionaryReplacementsLowerCase;
    const emotes: Record<number, string> = {};

    // must split exactly like the caption renderer so indexes line up
    const wordList = sentence.split(" ");
    let cursor = 0;
    for (const rawWord of wordList) {
      const word = isSensitive ? rawWord : rawWord.toLowerCase();
      // exact word first (keeps emotes like ":)" or "<3"), then without
      // surrounding punctuation ("LUL," / "(Kappa)")
      const candidates = [word, stripPunctuation(word)];
      for (const candidate of candidates) {
        if (!candidate) continue;
        const remapped = replacements[candidate];
        const key = remapped !== undefined ? (isSensitive ? remapped : remapped.toLowerCase()) : candidate;
        if (Object.hasOwn(dictionary, key)) {
          emotes[cursor] = dictionary[key];
          break;
        }
      }
      cursor += rawWord.length + 1;
    }
    return emotes;
  }

  // Last successful result per source, in priority order (later wins on name
  // clashes: globals first, then the channel's own emotes). Kept so a failed
  // refresh doesn't remove emotes that loaded before.
  #sources: Record<EmoteSource, Record<string, string>> = emptySources();
  #channelId = "";
  #loading?: Promise<number>;

  #rebuildDictionaries() {
    const dictionary: Record<string, string> = {};
    for (const source of SOURCE_ORDER)
      Object.assign(dictionary, this.#sources[source]);
    this.dictionary = dictionary;
    this.dictionaryLowerCase = Object.fromEntries(
      Object.entries(dictionary).map(([k, v]) => [k.toLowerCase(), v])
    );
  }

  /** Loads (or reloads) every emote set. Returns the number of emotes. */
  loadEmotes(id: string, apiClient: ApiClient): Promise<number> {
    this.updateReplacementsCache();
    if (!id || !apiClient)
      return Promise.resolve(0);
    // a refresh while one is already running just waits for that one
    if (this.#loading)
      return this.#loading;

    if (id !== this.#channelId) {
      this.#sources = emptySources();
      this.#channelId = id;
    }

    const twitch = (list: Promise<HelixEmote[]>) =>
      list.then(emotes => Object.fromEntries(emotes.map(e => [e.name, e.getImageUrl(1)])));

    const loaders: Record<EmoteSource, () => Promise<Record<string, string>>> = {
      twitchGlobal: () => twitch(apiClient.chat.getGlobalEmotes()),
      ffzGlobal: () => Load_FFZ_GLOBAL(),
      bttvGlobal: () => Load_BTTV_GLOBAL(),
      stvGlobal: () => Load_7TV_GLOBAL(),
      ffzChannel: () => Load_FFZ_CHANNEL(id),
      bttvChannel: () => Load_BTTV_CHANNEL(id),
      stvChannel: () => Load_7TV_CHANNEL(id),
      twitchChannel: () => twitch(apiClient.chat.getChannelEmotes(id)),
    };

    // fetch everything in parallel; one provider failing must not stop the rest
    this.#loading = Promise.allSettled(
      SOURCE_ORDER.map(async source => {
        try {
          this.#sources[source] = await loaders[source]();
        } catch (error) {
          console.warn(`[Emotes] ${source} failed to load, keeping previous emotes`, error);
        }
      })
    ).then(() => {
      // ignore results for a channel we've since logged out of / switched from
      if (this.#channelId === id)
        this.#rebuildDictionaries();
      return Object.keys(this.dictionary).length;
    }).finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  dispose() {
    this.#sources = emptySources();
    this.#channelId = "";
    this.dictionary = {};
    this.dictionaryLowerCase = {};
  }
}

const SOURCE_ORDER = [
  "twitchGlobal", "ffzGlobal", "bttvGlobal", "stvGlobal",
  "ffzChannel", "bttvChannel", "stvChannel", "twitchChannel",
] as const;
type EmoteSource = typeof SOURCE_ORDER[number];
const emptySources = () => Object.fromEntries(SOURCE_ORDER.map(s => [s, {}])) as Record<EmoteSource, Record<string, string>>;

export default TwitchEmotesApi;

// remove punctuation from the start and end of a word (Unicode aware, so
// accented letters and other scripts are kept)
function stripPunctuation(word: string) {
  return word.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, "");
}
