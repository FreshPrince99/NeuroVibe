# Like/Dislike Pipeline Audit (Emognition model integration)

## Bottom line

- **Model loading logic is correct in code**: the backend looks for `generic_model.pkl`, `scaler.pkl`, and `global_baseline.npy` under `backend/emognition_models`, which is where those files exist.
- **Calibration design is mostly correct** for your training setup (baseline correction + per-user z-score + isotonic recalibration on per-user labels).
- **Main risk is not “wrong loading”**; it is **domain shift + noisy labels + deployment/runtime issues**.

## What is correct right now

1. **Inference pipeline matches training assumptions**
   - 256 Hz Muse input is downsampled to 128 Hz, baseline-corrected, z-scored, featureized to 105 features, scaled, and classified.
   - This is aligned with the notebook training recipe.

2. **Calibration payload and backend handling are coherent**
   - Frontend sends baseline windows, calibration windows, and labels.
   - Backend builds a user profile with baseline, z-score stats, and optional isotonic calibrator.

3. **Timing is sufficient for isotonic in your current setup**
   - 20 s clips with 4 s windows gives 5 windows/clip.
   - 10 clips yields ~50 windows, which is above the minimum threshold used to allow isotonic fitting.

## What is risky / likely causing concern

1. **Your reported 79.8% is from a subject-dependent split**
   - This can overestimate real performance for a brand-new user versus strict leave-one-subject-out testing.
   - So “works in notebook” does not guarantee equal live performance.

2. **Clip-level self-report label is copied to all windows of that clip**
   - A single Like/Dislike button is applied to every 4 s segment from that clip.
   - This is practical, but creates weak/noisy window-level supervision.

3. **A runtime environment issue can masquerade as bad model loading**
   - In this environment, importing `backend/likedislike.py` failed because `numpy` is missing.
   - If your runtime setup is incomplete, you may think “model not loading” when it is really dependency failure.

4. **One UI text mismatch indicates calibration UX drift**
   - Code records 20 s per clip, but one error message still says 30 s per song.
   - Not a model bug, but a sign the implementation and UX messaging are not fully synchronized.

## Direct answer to your questions

- **Is the model loaded properly in software?**
  - **By code inspection: yes, the loading path and artifact names are correct.**
  - **Operationally: only if dependencies are installed and startup logs show the predictor initialized without warnings.**

- **Is the calibration stage correct / right way to do it?**
  - **Mostly yes for your chosen approach** (baseline + user z-score + isotonic recalibration).
  - It is a valid pragmatic calibration scheme.
  - But it is **not a guarantee of robust generalization**, and your offline metric may be optimistic for new users.

## High-priority next checks (to remove doubt fast)

1. Add a startup check endpoint field that confirms all three model artifacts loaded (`model/scaler/global_baseline`) and whether isotonic is active.
2. Log calibration class balance (`like` vs `dislike`) and reject extreme imbalance.
3. Re-evaluate with **participant-held-out** validation to estimate true first-time-user performance.
4. Keep clip labels, but consider adding per-window confidence filtering (artifact-heavy windows) before fitting isotonic.
