// Third-party emote providers. Each loader returns { emoteName: imageUrl }.
//
// A channel that simply isn't on a provider returns {}. Network or server
// errors throw, so a refresh can keep the previously loaded emotes instead of
// wiping them.

// some APIs return protocol-relative URLs ("//cdn..."), which break inside the
// app (tauri:// origin) - always use https
const absoluteUrl = (url: string) => url.startsWith("//") ? `https:${url}` : url;

// null when the channel/user isn't registered with the provider
async function fetchJson(url: string): Promise<any | null> {
  const resp = await fetch(url);
  if (resp.status === 404)
    return null;
  if (!resp.ok)
    throw new Error(`${url}: HTTP ${resp.status}`);
  return resp.json();
}

//region BTTV
function ParseBTTV(list: any[] | undefined, emotes: Record<string, string> = {}) {
  for (const emote of list ?? []) {
    if (emote?.code && emote?.id)
      emotes[emote.code] = `https://cdn.betterttv.net/emote/${emote.id}/1x`;
  }
  return emotes;
}

export async function Load_BTTV_GLOBAL() {
  return ParseBTTV(await fetchJson('https://api.betterttv.net/3/cached/emotes/global'));
}

export async function Load_BTTV_CHANNEL(id: string) {
  const data = await fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${id}`);
  return ParseBTTV(data?.sharedEmotes, ParseBTTV(data?.channelEmotes));
}
//endregion

//region FFZ
function ParseFFz(data: any) {
  const emotes: Record<string, string> = {};
  for (const set of Object.values<any>(data?.sets ?? {})) {
    for (const emoticon of set?.emoticons ?? []) {
      const url = emoticon?.urls?.["2"] ?? emoticon?.urls?.["1"];
      if (emoticon?.name && url)
        emotes[emoticon.name] = absoluteUrl(url);
    }
  }
  return emotes;
}

export async function Load_FFZ_GLOBAL() {
  return ParseFFz(await fetchJson('https://api.frankerfacez.com/v1/set/global'));
}

export async function Load_FFZ_CHANNEL(id: string) {
  return ParseFFz(await fetchJson(`https://api.frankerfacez.com/v1/room/id/${id}`));
}
//endregion

//region 7tv
// pick a specific file instead of relying on the order of the files list
const SEVENTV_FILE_PREFERENCE = ["2x.webp", "1x.webp", "2x.gif", "1x.gif"];
function Parse7TV(list: any[] | undefined) {
  const emotes: Record<string, string> = {};
  for (const emote of list ?? []) {
    const host = emote?.data?.host;
    const files: { name: string }[] = host?.files ?? [];
    const file = SEVENTV_FILE_PREFERENCE.map(n => files.find(f => f.name === n)).find(Boolean) ?? files[0];
    if (emote?.name && host?.url && file)
      emotes[emote.name] = absoluteUrl(`${host.url}/${file.name}`);
  }
  return emotes;
}

export async function Load_7TV_CHANNEL(id: string) {
  const data = await fetchJson(`https://7tv.io/v3/users/twitch/${id}`);
  return Parse7TV(data?.emote_set?.emotes);
}

export async function Load_7TV_GLOBAL() {
  const data = await fetchJson(`https://7tv.io/v3/emote-sets/global`);
  return Parse7TV(data?.emotes);
}
//endregion
