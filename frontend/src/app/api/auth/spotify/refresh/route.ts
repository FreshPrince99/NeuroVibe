import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const { refresh_token } = await request.json();

  if (!refresh_token) {
    return NextResponse.json({ error: "No refresh token provided" }, { status: 400 });
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "Spotify credentials not configured" }, { status: 500 });
  }

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token,
    }),
  });

  const data = await response.json();

  if (data.access_token) {
    return NextResponse.json({
      access_token: data.access_token,
      expires_in: data.expires_in ?? 3600,
    });
  }

  return NextResponse.json(
    { error: data.error || "Token refresh failed" },
    { status: 401 }
  );
}
