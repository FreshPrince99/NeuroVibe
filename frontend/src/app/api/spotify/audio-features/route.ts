import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { ids } = await req.json();
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "ids required" }, { status: 400 });
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_SECRET;
    if (!clientId || !clientSecret) {
      return NextResponse.json({ error: "Spotify credentials not configured" }, { status: 500 });
    }

    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

    if (!tokenRes.ok) {
      return NextResponse.json({ error: "token_error" }, { status: tokenRes.status });
    }

    const tokenData = await tokenRes.json();
    const token = tokenData.access_token as string;
    const idList = ids.slice(0, 50).join(",");

    const featuresRes = await fetch(
      `https://api.spotify.com/v1/audio-features?ids=${idList}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!featuresRes.ok) {
      return NextResponse.json({ error: "features_error" }, { status: featuresRes.status });
    }
    const featuresData = await featuresRes.json();

    const tracksRes = await fetch(
      `https://api.spotify.com/v1/tracks?ids=${idList}&market=US`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!tracksRes.ok) {
      return NextResponse.json({ error: "tracks_error" }, { status: tracksRes.status });
    }
    const tracksData = await tracksRes.json();

    return NextResponse.json({
      audio_features: featuresData?.audio_features ?? [],
      tracks: tracksData?.tracks ?? [],
    });
  } catch (e) {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
