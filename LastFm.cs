using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

// Last.fm scrobbling. The app signs every call with the shared secret here in the
// host (never exposed to the page). Flow: connect once (browser approval -> session
// key, saved to disk), then every played track updates now-playing + scrobbles once
// it passes Last.fm's threshold (>30s long and half-played, or 4 minutes in).
static class LastFm
{
    const string API_KEY = "7eed2a5f7d002e9d583a6c7c90e9b73c";
    const string SECRET = "5d4bdd062520e6c7aeeac4bae91ba6c7";
    const string ROOT = "https://ws.audioscrobbler.com/2.0/";
    static readonly HttpClient http = new HttpClient();

    static string sk = "";
    static string user = "";
    static string path = "";

    // Program sets this to push connection status to the page UI.
    public static Action<bool, string> OnStatus;

    public static bool Connected => !string.IsNullOrEmpty(sk);
    public static string User => user;

    public static void Load(string userDataDir)
    {
        try
        {
            path = Path.Combine(userDataDir, "lastfm.json");
            if (File.Exists(path))
            {
                var j = JsonDocument.Parse(File.ReadAllText(path)).RootElement;
                if (j.TryGetProperty("sk", out var s)) sk = s.GetString() ?? "";
                if (j.TryGetProperty("user", out var u)) user = u.GetString() ?? "";
            }
        }
        catch { }
    }

    static void Save()
    {
        try { File.WriteAllText(path, JsonSerializer.Serialize(new { sk, user })); } catch { }
    }

    static string Sig(SortedDictionary<string, string> p)
    {
        var sb = new StringBuilder();
        foreach (var kv in p) sb.Append(kv.Key).Append(kv.Value);
        sb.Append(SECRET);
        using var md5 = MD5.Create();
        return string.Concat(md5.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString())).Select(b => b.ToString("x2")));
    }

    static async Task<string> Call(SortedDictionary<string, string> p, bool post)
    {
        p["api_key"] = API_KEY;
        string sig = Sig(p); // sign BEFORE adding api_sig/format
        var form = p.Select(kv => new KeyValuePair<string, string>(kv.Key, kv.Value)).ToList();
        form.Add(new("api_sig", sig));
        form.Add(new("format", "json"));
        if (post)
        {
            var res = await http.PostAsync(ROOT, new FormUrlEncodedContent(form));
            return await res.Content.ReadAsStringAsync();
        }
        string qs = string.Join("&", form.Select(kv => Uri.EscapeDataString(kv.Key) + "=" + Uri.EscapeDataString(kv.Value)));
        return await http.GetStringAsync(ROOT + "?" + qs);
    }

    public static async Task Connect()
    {
        try
        {
            var tok = JsonDocument.Parse(await Call(new SortedDictionary<string, string> { ["method"] = "auth.getToken" }, false))
                .RootElement.GetProperty("token").GetString();
            string authUrl = "https://www.last.fm/api/auth/?api_key=" + API_KEY + "&token=" + tok;
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(authUrl) { UseShellExecute = true }); } catch { }

            for (int i = 0; i < 50; i++) // ~2.5 min for the user to approve in the browser
            {
                await Task.Delay(3000);
                try
                {
                    var root = JsonDocument.Parse(await Call(
                        new SortedDictionary<string, string> { ["method"] = "auth.getSession", ["token"] = tok }, false)).RootElement;
                    if (root.TryGetProperty("session", out var sess))
                    {
                        sk = sess.GetProperty("key").GetString() ?? "";
                        user = sess.GetProperty("name").GetString() ?? "";
                        Save();
                        OnStatus?.Invoke(true, user);
                        return;
                    }
                }
                catch { } // "unauthorized token" until the user approves — keep polling
            }
            OnStatus?.Invoke(false, "");
        }
        catch { OnStatus?.Invoke(false, ""); }
    }

    public static void Disconnect()
    {
        sk = ""; user = ""; Save();
        OnStatus?.Invoke(false, "");
    }

    public static void Status() => OnStatus?.Invoke(Connected, user);

    // --- scrobble state driven by the same rpc ticks that feed Discord/SMTC ---
    static string curTrack = "", curArtist = "";
    static long curStart = 0;
    static bool curScrobbled = false;
    static long lastNp = 0;

    public static void Track(string track, string artist, int pos, int dur, bool paused)
    {
        if (!Connected || string.IsNullOrWhiteSpace(track) || string.IsNullOrWhiteSpace(artist)) return;

        if (track != curTrack || artist != curArtist)
        {
            curTrack = track; curArtist = artist; curScrobbled = false; lastNp = 0;
            curStart = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - Math.Max(0, pos);
        }
        if (paused) return;

        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (now - lastNp > 25) { lastNp = now; _ = NowPlaying(artist, track, dur); }
        if (!curScrobbled && dur >= 30 && pos >= Math.Min(dur / 2, 240))
        {
            curScrobbled = true;
            _ = Scrobble(artist, track, dur, curStart);
        }
    }

    static async Task NowPlaying(string artist, string track, int dur)
    {
        var p = new SortedDictionary<string, string> { ["method"] = "track.updateNowPlaying", ["artist"] = artist, ["track"] = track, ["sk"] = sk };
        if (dur > 0) p["duration"] = dur.ToString();
        try { await Call(p, true); } catch { }
    }

    static async Task Scrobble(string artist, string track, int dur, long ts)
    {
        var p = new SortedDictionary<string, string> { ["method"] = "track.scrobble", ["artist"] = artist, ["track"] = track, ["timestamp"] = ts.ToString(), ["sk"] = sk };
        if (dur > 0) p["duration"] = dur.ToString();
        try { await Call(p, true); } catch { }
    }
}
