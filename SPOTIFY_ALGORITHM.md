  Spotify Audio Features Used

  Four features are fetched per track from Spotify's Audio Features API:

  ┌──────────────┬─────────┬───────────────────────────────────────────────────────────────┐
  │   Feature    │  Range  │                         What it means                         │
  ├──────────────┼─────────┼───────────────────────────────────────────────────────────────┤
  │ energy       │ 0.0–1.0 │ Intensity and activity — loud, fast, noisy = high             │
  ├──────────────┼─────────┼───────────────────────────────────────────────────────────────┤
  │ valence      │ 0.0–1.0 │ Musical positivity — happy, euphoric = high; sad, angry = low │
  ├──────────────┼─────────┼───────────────────────────────────────────────────────────────┤
  │ danceability │ 0.0–1.0 │ Rhythmic suitability for dancing                              │
  ├──────────────┼─────────┼───────────────────────────────────────────────────────────────┤
  │ popularity   │ 0–100   │ Spotify's own popularity metric                               │
  └──────────────┴─────────┴───────────────────────────────────────────────────────────────┘

  Scoring formula (run on each candidate track):
  score = (1 - |track.energy - targetEnergy|)
        + 0.30 × valenceScore
        + 0.15 × danceScore
        + 0.05 × (popularity / 100)
  Energy match is the dominant factor. The top 5 scoring tracks are short-listed and one is picked randomly to avoid
  repetition.

  ---
  Full Algorithm — Both Modes

  Shared Inputs

  - Rule-based emotion (every ~5s): focus | stress | relaxed | tired
  - NeuroSense valence (every ~4s): raw prob_negative accumulated into a 15-window (~60s) rolling average → POSITIVE |
  NEGATIVE | UNCERTAIN

  ---
  Focus Mode

  Goal: Sustain productive cognitive state. Energy level should match the user's arousal — not too high, not too low.

  Setup at session start:
  - User picks energy preference: energetic (baseline = 0.70) or calm (baseline = 0.40)
  - User picks preferred genres; these form the front of the genre queue

  Track search query:
  - If stress is dominant emotion → "calming soothing focus [genre]"
  - Otherwise → "deep focus [energy_word] [genre]" where energy_word maps the current adaptive energy to: upbeat
  energetic fast / moderate steady focused / calm relaxing slow / ambient meditative very slow

  Track scoring — target energy:
  - If stress is dominant → force target = 0.20 (always go calming when stressed)
  - Otherwise → use adaptiveEnergy (starts at baseline, drifts over time)

  Valence weight:
  - When stressed: valenceScore = track.valence (want uplifting, positive-sounding music)
  - When not stressed: valenceScore = track.valence × 0.3 (valence matters less in focus mode, energy matters most)

  Danceability weight: danceScore = danceability (rhythmic can aid focus)

  ---
  Layer 1 — Energy adaptation (evaluated at end of each track, ~3–4 min):

  Tallies emotion labels received during the track, then:

  if stress% > 35%       → adaptiveEnergy -= 0.08   (too stressed, calm down)
  elif tired/relaxed% > 35% → adaptiveEnergy += 0.08   (too low-energy, lift up)
  else                   → adaptiveEnergy += (baseline - adaptiveEnergy) × 0.25  (gentle drift back)

  adaptiveEnergy clamped to [0.15, 0.90]

  Layer 2 — Genre rotation (evaluated every 5 songs, ~15–20 min):

  At end of each track:
    if valence == POSITIVE  → dislikeScore = 0.0  (user is responding well)
    if valence == NEGATIVE  → dislikeScore = 1.0  (user is not enjoying it)
    if valence == UNCERTAIN → skip (don't contribute to block)

  After every 5 songs:
    avgDislikeScore = mean(blockScores)
    if avgDislikeScore >= 0.5 → rotate to next genre
    else                      → stay in current genre

  ---
  Relaxation Mode

  Goal: Wind the user down. Energy is always kept low regardless of emotion. Calming, non-rhythmic music.

  Setup at session start:
  - No energy preference pick — relaxation always targets 0.25
  - Same genre queue logic

  Track search query:
  - If stress is dominant → "calming uplifting relaxation [energy_word] [genre]" (acknowledge the stress, guide toward
  calm)
  - Otherwise → "gentle peaceful relaxing [energy_word] [genre]"

  Track scoring — target energy:
  - Always forced to 0.25 regardless of adaptive energy or emotion (no stressed override needed — it's already calm)

  Valence weight:
  - Always valenceScore = track.valence (in relaxation, uplifting music always preferred regardless of emotion)

  Danceability weight: danceScore = 1 - danceability (penalise rhythmic/danceable tracks — want ambient, flowing music)

  Layer 1 — Energy adaptation:
  - Runs the same emotion tally logic, but since target energy is hard-fixed at 0.25 in scoreTrack, the adaptive energy
  only affects the search query text (the energy_word). The actual track selection always gravitates toward calm. So in
  relaxation mode, Layer 1 mostly influences the wording of the Spotify search, not the audio features filter.

  Layer 2 — Genre rotation:
  - Identical to Focus Mode — valence POSITIVE/NEGATIVE drives genre block scoring every 5 songs.

  ---
  Song Change Frequency Summary

  ┌──────────────────────┬─────────────────────────────────────────────────────────────┬─────────────────┐
  │       Trigger        │                        When it fires                        │      Mode       │
  ├──────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────┤
  │ Track ends naturally │ Every ~3–4 minutes (Spotify track length)                   │ Both            │
  ├──────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────┤
  │ Genre rotation       │ After every 5 songs (~15–20 min), only if avg dislike ≥ 0.5 │ Both            │
  ├──────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────┤
  │ Energy shift         │ Takes effect on the next track (no mid-track interruption)  │ Focus primarily │
  ├──────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────┤
  │ Mid-track skip       │ Not implemented — valence only acts at track boundaries     │ Both            │
  └──────────────────────┴─────────────────────────────────────────────────────────────┴─────────────────┘

  ---
  What Changes vs Current System

  ┌──────────────────────────────────────────────────────┬──────────────────────────────────────────────────────────┐
  │                       Current                        │                           New                            │
  ├──────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ Emognition like/dislike model (105 features, 128 Hz) │ NeuroSense valence model (128 features, 256 Hz)          │
  ├──────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ Requires calibration song-voting to fit isotonic     │ No calibration needed — dead zone (0.40/0.60) replaces   │
  │ recalibrator                                         │ it                                                       │
  ├──────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ Baseline recording → keeps for rule-based emotion    │ Baseline recording → unchanged, still kept               │
  ├──────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ label === "dislike" ? 1.0 : 0.0 in genre block       │ POSITIVE=0.0, NEGATIVE=1.0, UNCERTAIN=skip               │
  ├──────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤
  │ Emits likedislike_prediction                         │ Emits valence_prediction with {valence, smoothed_score,  │
  │                                                      │ n_windows}                                               │
  └──────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘