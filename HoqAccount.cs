using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

// hoq accounts (holdonquietly.com): one account for the site and every hoq app.
// Nothing to do with SoundCloud's own sign-in, which stays in the WebView2 profile.
//
// The app is a "native" OAuth client (holdonquietly-site/ACCOUNTS.md, flow C):
// sign-in opens the browser at holdonquietly.com, which sends the person back to a
// one-shot listener on 127.0.0.1 (authorization code + PKCE; a desktop app can't
// keep a client secret). The refresh token is kept with DPAPI, never in plain text.
//
// Refresh tokens rotate on every use, and the server treats an old one coming back
// as theft and signs the app out. So: one token request at a time (gate), and the
// new token is saved before anything else happens.
static class HoqAccount
{
    static readonly string ORIGIN = (Environment.GetEnvironmentVariable("HOQ_ACCOUNTS_ORIGIN") ?? "https://holdonquietly.com").TrimEnd('/');
    static readonly string CLIENT_ID = Environment.GetEnvironmentVariable("HOQ_ACCOUNTS_CLIENT") ?? "holdonquietly-soundcloud.427587b6";
    const string SCOPES = "openid profile offline_access";

    public static Action<string> RunJs;                    // pushes state to the page
    static readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
    static readonly SemaphoreSlim gate = new SemaphoreSlim(1, 1);
    static string file;                                    // the DPAPI blob
    static string refresh = "", access = "";
    static DateTime accessUntil;
    static JsonElement? user;                              // userinfo claims, as the server sent them
    static CancellationTokenSource signing;
    static string note = "";                               // last problem, shown in Settings

    public static bool SignedIn => !string.IsNullOrEmpty(refresh);

    public static void Load(string userData)
    {
        file = Path.Combine(userData, "hoq-account.dat");
        try
        {
            if (File.Exists(file))
            {
                var j = JsonDocument.Parse(Unprotect(File.ReadAllBytes(file))).RootElement;
                refresh = j.TryGetProperty("rt", out var rt) ? rt.GetString() ?? "" : "";
                if (j.TryGetProperty("user", out var u) && u.ValueKind == JsonValueKind.Object) user = u.Clone();
            }
        }
        catch (Exception ex) { Program.Log("hoq account: saved sign-in unreadable (" + ex.GetType().Name + ")"); refresh = ""; user = null; }
        // Freshen the name/picture and prove the sign-in still works. Offline is
        // fine: the saved profile shows until the next successful refresh.
        if (SignedIn) _ = Task.Run(async () => { await Task.Delay(4000); await RefreshProfile(); });
    }

    // Settings asks for the current state when it opens.
    public static void Status() => Push();

    public static async Task SignIn()
    {
        if (signing != null) return;
        signing = new CancellationTokenSource(TimeSpan.FromMinutes(5));
        note = "";
        Push();
        TcpListener listener = null;
        try
        {
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            string redirect = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/callback";
            string verifier = B64Url(RandomNumberGenerator.GetBytes(32));
            string challenge = B64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
            string state = B64Url(RandomNumberGenerator.GetBytes(16));
            string url = ORIGIN + "/account/authorize/?response_type=code&client_id=" + E(CLIENT_ID) +
                         "&redirect_uri=" + E(redirect) + "&scope=" + E(SCOPES) + "&state=" + state +
                         "&code_challenge=" + challenge + "&code_challenge_method=S256";
            // Tests drive the browser side themselves (HOQ_ACCOUNTS_NO_BROWSER=1).
            if (Environment.GetEnvironmentVariable("HOQ_ACCOUNTS_NO_BROWSER") == "1") Program.Log("hoq account: authorize " + url);
            else System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true });

            var q = await WaitForCallback(listener, state, signing.Token);
            if (q == null) { note = "Sign-in didn't come back to the app. Try again."; return; }
            if (q.TryGetValue("error", out var err))
            {
                note = err == "access_denied" ? "Sign-in was cancelled." : "holdonquietly said: " + (q.TryGetValue("error_description", out var d) ? d : err);
                return;
            }
            await gate.WaitAsync();
            try
            {
                var tok = await TokenRequest(new Dictionary<string, string>
                {
                    ["grant_type"] = "authorization_code", ["code"] = q["code"], ["redirect_uri"] = redirect,
                    ["code_verifier"] = verifier, ["client_id"] = CLIENT_ID,
                });
                if (tok == null) { note = "holdonquietly didn't accept the sign-in. Try again."; return; }
                Take(tok.Value);
            }
            finally { gate.Release(); }
            await LoadUser();
            Program.Log("hoq account: signed in");
        }
        catch (OperationCanceledException) { if (!SignedIn) note = "Sign-in timed out or was cancelled."; }
        catch (Exception ex) { note = "Couldn't reach holdonquietly.com."; Program.Log("hoq account: sign-in failed: " + ex.GetType().Name + " " + ex.Message); }
        finally
        {
            try { listener?.Stop(); } catch { }
            signing?.Dispose();
            signing = null;
            Push();
        }
    }

    public static void CancelSignIn() { try { signing?.Cancel(); } catch { } }

    public static async Task SignOut()
    {
        await gate.WaitAsync();
        try
        {
            string rt = refresh;
            refresh = access = "";
            user = null;
            note = "";
            try { if (File.Exists(file)) File.Delete(file); } catch { }
            if (!string.IsNullOrEmpty(rt))
            {
                try
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                    await http.PostAsync(ORIGIN + "/api/account/oauth/revoke", new FormUrlEncodedContent(
                        new Dictionary<string, string> { ["token"] = rt, ["client_id"] = CLIENT_ID }), cts.Token);
                }
                catch { }   // signed out here either way; the token dies on its own
            }
            Program.Log("hoq account: signed out");
        }
        finally { gate.Release(); Push(); }
    }

    // A valid access token for calling hoq APIs, refreshing when it's near expiry.
    // Empty when signed out or offline.
    public static async Task<string> AccessToken()
    {
        if (!SignedIn) return "";
        if (!string.IsNullOrEmpty(access) && DateTime.UtcNow < accessUntil) return access;
        await gate.WaitAsync();
        try
        {
            if (!string.IsNullOrEmpty(access) && DateTime.UtcNow < accessUntil) return access;   // someone else just did it
            if (!SignedIn) return "";
            var tok = await TokenRequest(new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token", ["refresh_token"] = refresh, ["client_id"] = CLIENT_ID,
            });
            if (tok == null) return "";
            Take(tok.Value);
            return access;
        }
        finally { gate.Release(); }
    }

    static async Task RefreshProfile()
    {
        try { if (!string.IsNullOrEmpty(await AccessToken())) await LoadUser(); }
        catch (Exception ex) { Program.Log("hoq account: refresh failed (" + ex.GetType().Name + ") — keeping the saved profile"); }
        Push();
    }

    // POST to the token endpoint. null = refused (the reason is logged/noted);
    // a refused refresh token means this sign-in is over, so it's dropped here.
    // Network errors throw, so a bad connection never signs anyone out.
    static async Task<JsonElement?> TokenRequest(Dictionary<string, string> form)
    {
        var resp = await http.PostAsync(ORIGIN + "/api/account/oauth/token", new FormUrlEncodedContent(form));
        string body = await resp.Content.ReadAsStringAsync();
        JsonElement j;
        try { j = JsonDocument.Parse(body).RootElement.Clone(); }
        catch { throw new HttpRequestException("token endpoint answered " + (int)resp.StatusCode + " with non-JSON"); }
        if (resp.IsSuccessStatusCode && j.TryGetProperty("access_token", out _)) return j;
        string err = j.TryGetProperty("error", out var e) ? e.GetString() : "";
        Program.Log("hoq account: token request refused: " + err + " " + (j.TryGetProperty("error_description", out var d) ? d.GetString() : ""));
        if ((int)resp.StatusCode >= 500 || err == "slow_down") throw new HttpRequestException("token endpoint busy");
        if (form["grant_type"] == "refresh_token" && err == "invalid_grant")
        {
            refresh = access = "";
            user = null;
            try { if (File.Exists(file)) File.Delete(file); } catch { }
            note = "You were signed out of holdonquietly. Sign in again.";
        }
        return null;
    }

    // Keep the new tokens, saving the (rotated) refresh token straight away.
    static void Take(JsonElement tok)
    {
        access = tok.GetProperty("access_token").GetString() ?? "";
        int ttl = tok.TryGetProperty("expires_in", out var x) && x.ValueKind == JsonValueKind.Number ? x.GetInt32() : 3600;
        accessUntil = DateTime.UtcNow.AddSeconds(Math.Max(60, ttl - 120));
        if (tok.TryGetProperty("refresh_token", out var rt) && rt.GetString() is string r && r.Length > 0) refresh = r;
        Save();
    }

    static async Task LoadUser()
    {
        string at = await AccessToken();
        if (string.IsNullOrEmpty(at)) return;
        using var req = new HttpRequestMessage(HttpMethod.Get, ORIGIN + "/api/account/oauth/userinfo");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", at);
        using var resp = await http.SendAsync(req);
        if (!resp.IsSuccessStatusCode) { Program.Log("hoq account: userinfo answered " + (int)resp.StatusCode); return; }
        user = JsonDocument.Parse(await resp.Content.ReadAsStringAsync()).RootElement.Clone();
        Save();
    }

    static void Save()
    {
        if (string.IsNullOrEmpty(file)) return;
        try
        {
            string json = JsonSerializer.Serialize(new Dictionary<string, object> { ["rt"] = refresh, ["user"] = user });
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            string tmp = file + ".tmp";
            File.WriteAllBytes(tmp, Protect(Encoding.UTF8.GetBytes(json)));
            File.Move(tmp, file, true);
        }
        catch (Exception ex) { Program.Log("hoq account: couldn't save sign-in: " + ex.Message); }
    }

    // What the page gets: never a token, only who's signed in.
    static void Push()
    {
        var s = new Dictionary<string, object>
        {
            ["signedIn"] = SignedIn,
            ["busy"] = signing != null,
            ["note"] = note,
        };
        if (SignedIn && user is JsonElement u)
        {
            string P(string k) => u.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            s["user"] = new Dictionary<string, object>
            {
                ["id"] = P("sub"), ["username"] = P("preferred_username"), ["name"] = P("name"),
                ["picture"] = P("picture"), ["profile"] = P("profile"), ["role"] = P("hoq_role"),
            };
        }
        RunJs?.Invoke("window.__hoqAccount && window.__hoqAccount(" + JsonSerializer.Serialize(s) + ")");
    }

    // Serve exactly one request on the loopback listener: the browser coming back
    // from holdonquietly.com. Anything else (favicon, a stray tab) gets a 404 and
    // the wait goes on. The state check makes sure it's our sign-in coming back.
    static async Task<Dictionary<string, string>> WaitForCallback(TcpListener listener, string state, CancellationToken ct)
    {
        while (true)
        {
            using var client = await listener.AcceptTcpClientAsync(ct);
            using var stream = client.GetStream();
            stream.ReadTimeout = 5000;
            var buf = new byte[8192];
            int n = await stream.ReadAsync(buf, 0, buf.Length, ct);
            string first = Encoding.ASCII.GetString(buf, 0, n).Split('\n')[0];   // GET /callback?code=... HTTP/1.1
            var parts = first.Split(' ');
            string target = parts.Length >= 2 ? parts[1] : "";
            if (!target.StartsWith("/callback?", StringComparison.Ordinal))
            {
                await Reply(stream, 404, "not here");
                continue;
            }
            var q = new Dictionary<string, string>();
            foreach (var kv in target.Substring(10).Split('&'))
            {
                int i = kv.IndexOf('=');
                if (i > 0) q[Uri.UnescapeDataString(kv.Substring(0, i))] = Uri.UnescapeDataString(kv.Substring(i + 1).Replace('+', ' '));
            }
            if (!q.TryGetValue("state", out var st) || st != state)
            {
                await Reply(stream, 400, Page("that sign-in link wasnt from this app", "start it again from holdonquietly's settings"));
                continue;
            }
            if (q.TryGetValue("iss", out var iss) && iss.TrimEnd('/') != ORIGIN)
            {
                await Reply(stream, 400, Page("that sign-in came from the wrong place", "start it again from holdonquietly's settings"));
                return null;
            }
            bool ok = q.ContainsKey("code");
            await Reply(stream, 200, ok ? Page("ur signed in", "u can close this tab n go back to the app")
                                        : Page("sign-in didnt finish", "go back to the app n try again"));
            return q;
        }
    }

    static async Task Reply(NetworkStream s, int code, string html)
    {
        byte[] body = Encoding.UTF8.GetBytes(html);
        string head = "HTTP/1.1 " + code + (code == 200 ? " OK" : code == 404 ? " Not Found" : " Bad Request") +
                      "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + body.Length +
                      "\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n";
        byte[] h = Encoding.ASCII.GetBytes(head);
        await s.WriteAsync(h, 0, h.Length);
        await s.WriteAsync(body, 0, body.Length);
        await s.FlushAsync();
    }

    static string Page(string title, string line) =>
        "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>holdonquietly</title>" +
        "<body style=\"margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#141418;color:#c9c9d2;" +
        "font:15px/1.5 Verdana,Tahoma,sans-serif;text-align:center\"><div><div style=\"font-size:20px;font-weight:700;color:#fff;margin-bottom:6px\">" +
        WebUtility.HtmlEncode(title) + "</div><div>" + WebUtility.HtmlEncode(line) + "</div></div>";

    static string E(string s) => Uri.EscapeDataString(s);
    static string B64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    // ---- DPAPI (current user), straight from crypt32: no extra package ----
    [StructLayout(LayoutKind.Sequential)]
    struct BLOB { public int cbData; public IntPtr pbData; }
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CryptProtectData(ref BLOB data, string desc, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref BLOB output);
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CryptUnprotectData(ref BLOB data, IntPtr desc, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref BLOB output);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
    const int CRYPTPROTECT_UI_FORBIDDEN = 1;

    internal static byte[] Protect(byte[] plain) => Dpapi(plain, true);
    internal static byte[] Unprotect(byte[] sealedBytes) => Dpapi(sealedBytes, false);

    static byte[] Dpapi(byte[] input, bool protect)
    {
        var inB = new BLOB { cbData = input.Length, pbData = Marshal.AllocHGlobal(input.Length) };
        var outB = new BLOB();
        try
        {
            Marshal.Copy(input, 0, inB.pbData, input.Length);
            bool ok = protect
                ? CryptProtectData(ref inB, "holdonquietly account", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref outB)
                : CryptUnprotectData(ref inB, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref outB);
            if (!ok) throw new CryptographicException(Marshal.GetLastWin32Error());
            var res = new byte[outB.cbData];
            Marshal.Copy(outB.pbData, res, 0, outB.cbData);
            return res;
        }
        finally
        {
            Marshal.FreeHGlobal(inB.pbData);
            if (outB.pbData != IntPtr.Zero) LocalFree(outB.pbData);
        }
    }
}
