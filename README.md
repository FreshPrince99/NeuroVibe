# NeuroVibe

This application involves using a deep learning model to track EEG signals with the Muse 2 headband to predict a user's emotion state and based on their state play music according to their mood.

## Frontend


## Backend
The backend of the application comprises of several components

### Recording the signals
Using the open source software BlueMuse, we connect the Muse 2 headband and use pythonlsl to stream the live signals from all 4 channels. This code can be run using the stream.py script. Before running this, please ensure that your laptop is connected to the BlueMuse app and the Start Streaming option is clicked.

### Setup
1. First create a virtual environment to download all the libraries by running

python -m venv .venv
.\.venv\Scripts\Activate.ps1

2. Download requirements
pip install -r requirements.txt

3. Run the muselsl viewer to view the EEG signals
muselsl view

4. Stream the data by running 
python stream.py
