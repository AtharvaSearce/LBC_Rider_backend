const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// In-memory data store for the MVP
let manifest = null;
let deliveryHistory = [];

const dataPath = path.join(__dirname, 'data', 'manifest.json');

// Helper to reload manifest
function loadManifest() {
  if (!manifest) {
    const data = fs.readFileSync(dataPath, 'utf8');
    manifest = JSON.parse(data);
  }
}

// ----------------------------------------------------
// Manifest API
// ----------------------------------------------------

app.get('/api/manifest', (req, res) => {
  loadManifest();
  res.json(manifest);
});

app.get('/api/manifest/stop/:id', (req, res) => {
  loadManifest();
  const stop = manifest.stops.find(s => s.id === req.params.id);
  if (stop) {
    res.json(stop);
  } else {
    res.status(404).json({ error: 'Stop not found' });
  }
});

// ----------------------------------------------------
// Route API
// ----------------------------------------------------

app.post('/api/route/optimize', (req, res) => {
  const { stops, priorityStopId } = req.body;
  
  if (!stops || !Array.isArray(stops)) {
    return res.status(400).json({ error: 'Invalid stops array' });
  }

  let optimized = [...stops];

  // If there's a priority stop, lock it to the top of the pending list
  if (priorityStopId) {
    const priorityIndex = optimized.findIndex(s => s.id === priorityStopId);
    if (priorityIndex > -1) {
      const priorityStop = optimized.splice(priorityIndex, 1)[0];
      
      // Find the first pending stop to insert the priority stop before it
      const firstPendingIndex = optimized.findIndex(s => s.status === 'pending');
      
      if (firstPendingIndex > -1) {
        optimized.splice(firstPendingIndex, 0, priorityStop);
      } else {
        optimized.push(priorityStop);
      }
      
      // Re-sequence pending stops
      let seqCounter = optimized.filter(s => s.status !== 'pending').length + 1;
      optimized.forEach(s => {
        if (s.status === 'pending') {
          s.sequence = seqCounter++;
        }
      });
    }
  }

  // Update in-memory manifest
  if (manifest) {
    manifest.stops = optimized;
  }

  res.json(optimized);
});

app.get('/api/route/compute', (req, res) => {
  // Mock polyline and ETA for MVP map view
  res.json({
    polyline: [
      { lat: parseFloat(req.query.originLat), lng: parseFloat(req.query.originLng) },
      { lat: parseFloat(req.query.destLat), lng: parseFloat(req.query.destLng) }
    ],
    eta: '5 mins',
    distance: '1.2 km'
  });
});

// ----------------------------------------------------
// Delivery API
// ----------------------------------------------------

app.post('/api/delivery/:id/complete', (req, res) => {
  loadManifest();
  const { id } = req.params;
  const result = req.body;
  
  const stopIndex = manifest.stops.findIndex(s => s.id === id);
  if (stopIndex > -1) {
    manifest.stops[stopIndex].status = 'completed';
    manifest.stops[stopIndex].completedAt = result.timestamp;
    manifest.completedStops++;
    
    // Save to history
    deliveryHistory.push({ ...result, id: uuidv4() });
    
    // Find next pending stop
    const nextStop = manifest.stops.find((s, idx) => idx > stopIndex && s.status === 'pending') || null;
    res.json({ success: true, nextStop });
  } else {
    res.status(404).json({ error: 'Stop not found' });
  }
});

app.post('/api/delivery/:id/fail', (req, res) => {
  loadManifest();
  const { id } = req.params;
  const result = req.body;
  
  const stopIndex = manifest.stops.findIndex(s => s.id === id);
  if (stopIndex > -1) {
    manifest.stops[stopIndex].status = 'failed';
    manifest.stops[stopIndex].attemptCount++;
    manifest.stops[stopIndex].failureReason = result.failureReason;
    manifest.failedStops++;
    
    // Save to history
    deliveryHistory.push({ ...result, id: uuidv4() });
    
    // Find next pending stop
    const nextStop = manifest.stops.find((s, idx) => idx > stopIndex && s.status === 'pending') || null;
    res.json({ success: true, nextStop });
  } else {
    res.status(404).json({ error: 'Stop not found' });
  }
});

app.get('/api/deliveries/history', (req, res) => {
  let filtered = [...deliveryHistory];
  
  if (req.query.status) {
    filtered = filtered.filter(h => h.outcome === req.query.status);
  }
  
  res.json(filtered);
});

// ----------------------------------------------------
// AI Chatbot API (Mock LLM)
// ----------------------------------------------------

app.post('/api/ai/command', (req, res) => {
  // In the real implementation, this would call Vertex AI or Gemini
  // For the MVP, the parsing is handled on the client-side `aiParser.ts`
  // This endpoint simply echoes back for testing server connectivity.
  res.json({
    message: "Server received command: " + req.body.text
  });
});

// Start Server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`LBC Rider mock backend running on port ${PORT}`);
});
