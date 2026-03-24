import { NextResponse } from "next/server";

export async function GET() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const redirectUri = "http://127.0.0.1:3000/api/auth/callback";
  
  console.log("Spotify Auth - Client ID exists:", !!clientId);
  console.log("Spotify Auth - Client ID:", clientId);
  console.log("Spotify Auth - Redirect URI:", redirectUri);
  
  if (!clientId) {
    return NextResponse.json({ error: "Spotify Client ID not configured" }, { status: 500 });
  }
  
  const scope = [
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-read-playback-state",
    "user-modify-playback-state",
  ].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: scope,
    redirect_uri: redirectUri,
  });

  const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;
  console.log("Spotify Auth URL:", authUrl);

  return NextResponse.redirect(authUrl);
}
