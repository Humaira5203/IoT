const express = require('express');
const mqtt = require('mqtt');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql');
const bcrypt = require('bcrypt');
const multer = require('multer'); // Add this line
const path = require('path'); // Add this line

// MQTT credentials
const mqtt_url = 'mqtt://05399b96ecd0479383f3a364f0cc4552.s1.eu.hivemq.cloud:8883';
const mqtt_username = 'testuser';
const mqtt_password = 'Test1234';

// Create Express app
const app = express();
let port = 4001; // Initial port

// Use middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); // For form data

// Set view engine to EJS
app.set('view engine', 'ejs');

// Set up storage engine for multer
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: function (req, file, cb) {
    cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 1000000 },
  fileFilter: function (req, file, cb) {
    checkFileType(file, cb);
  }
}).single('file');

// Check file type
function checkFileType(file, cb) {
  const filetypes = /jpeg|jpg|png|gif/;
  const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = filetypes.test(file.mimetype);

  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb('Error: Images Only!');
  }
}

// Serve static files from the uploads folder
app.use('/uploads', express.static('uploads'));

// MQTT connection options
const mqtt_options = {
  username: mqtt_username,
  password: mqtt_password,
  port: 8883,
  protocol: 'mqtts',
  rejectUnauthorized: false
};

// Create MQTT client
const client = mqtt.connect(mqtt_url, mqtt_options);

// Variable to store the latest MAC address and timestamp
let latestMacAddress = '';
let lastMessageTime = {};

// MQTT connection
client.on('connect', () => {
  console.log('Connected to MQTT broker');
  client.subscribe('device_ping', (err) => {
    if (!err) {
      console.log('Subscribed to device_ping');
    } else {
      console.error('Failed to subscribe: ', err);
    }
  });
});

client.on('error', (err) => {
  console.error('MQTT connection error:', err);
});

// Create connection to MySQL database
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root', // use your MySQL username
  password: 'eren23', // use your MySQL password
  database: 'flutter_auth'
});

// Connect to the database
db.connect((err) => {
  if (err) {
    throw err;
  }
  console.log('MySQL Connected...');
});

// Handle incoming MQTT messages
client.on('message', (topic, message) => {
  if (topic === 'device_ping') {
    latestMacAddress = message.toString();
    const currentTime = Date.now();

    console.log(`Received MAC address on ${topic}: ${latestMacAddress}`);

    lastMessageTime[latestMacAddress] = currentTime;

    const sqlCheck = 'SELECT * FROM devices WHERE device_name = ?';
    db.query(sqlCheck, [latestMacAddress], (err, result) => {
      if (err) {
        console.error('Database query error:', err);
        return;
      }

      if (result.length > 0) {
        // Entry exists, update the status to on
        const sqlUpdateOn = 'UPDATE devices SET status = ?, last_update = NOW() WHERE device_name = ?';
        db.query(sqlUpdateOn, ['on', latestMacAddress], (err, updateResult) => {
          if (err) {
            console.error('Failed to update status to on:', err);
            return;
          }
          console.log(`Updated status to on for device: ${latestMacAddress}`);
        });
      } else {
        // Entry does not exist, create a new entry
        const sqlInsert = 'INSERT INTO devices (device_name, status, last_update) VALUES (?, ?, NOW())';
        db.query(sqlInsert, [latestMacAddress, 'on'], (err, insertResult) => {
          if (err) {
            console.error('Failed to insert new device:', err);
            return;
          }
          console.log(`Inserted new device: ${latestMacAddress}`);
        });
      }
    });
  }
});

// Check for inactive devices
setInterval(() => {
  const currentTime = Date.now();
  for (const mac in lastMessageTime) {
    if ((currentTime - lastMessageTime[mac]) > 30000) { // If the device has been inactive for more than 30 seconds
      // Query to update the device status to 'off' and set the last_update timestamp to the current time
      const sqlUpdateOff = 'UPDATE devices SET status = ?, last_update = NOW() WHERE device_name = ?';
      
      // Execute the query
      db.query(sqlUpdateOff, ['off', mac], (err, updateResult) => {
        if (err) {
          // Log an error message if the query fails
          console.error('Failed to update status to off:', err);
          return; // Exit the function to avoid further processing
        }
        
        // Log a success message indicating the device status was set to 'off'
        console.log(`Status set to off for device: ${mac} due to inactivity`);

        // Remove the device from the lastMessageTime object to stop tracking its inactivity
        delete lastMessageTime[mac];
      });
    }
  }
}, 10000); // Check every 10 seconds

// Render dashboard page
app.get('/dashboard', (req, res) => {
  const sql = 'SELECT device_name, status, last_update, TIMESTAMPDIFF(SECOND, last_update, NOW()) AS duration FROM devices';
  db.query(sql, (err, results) => {
    if (err) {
      return res.status(500).send('Server error');
    }

    const devices = results.map(device => {
      const activeDuration = device.status === 'on' ? formatDuration(device.duration) : '0h 0m 0s';
      const inactiveDuration = device.status === 'off' ? formatDuration(device.duration) : '0h 0m 0s';
      const lastActive = new Date(device.last_update).toLocaleString();
      return {
        device_name: device.device_name,
        status: device.status,
        lastActive: lastActive,
        activeDuration: activeDuration,
        inactiveDuration: inactiveDuration
      };
    });

    res.render('dashboard', { devices: devices });
  });
});

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours}h ${minutes}m ${secs}s`;
}

// Register user
app.post('/register', (req, res) => {
  const email = req.body.email;
  const password = req.body.password;
  const confirmPassword = req.body.confirmPassword;

  if (password !== confirmPassword) {
    return res.status(400).send('Passwords do not match');
  }

  bcrypt.hash(password, 10, (err, hash) => {
    if (err) {
      return res.status(500).send('Server error');
    }

    const sql = 'INSERT INTO users (email, password) VALUES (?, ?)';
    db.query(sql, [email, hash], (err, result) => {
      if (err) {
        return res.status(500).send('Server error');
      }
      res.status(200).send('User registered');
    });
  });
});

// Login user
app.post('/login', (req, res) => {
  const email = req.body.email;
  const password = req.body.password;

  const sql = 'SELECT * FROM users WHERE email = ?';
  db.query(sql, [email], (err, result) => {
    if (err) {
      return res.status(500).send('Server error');
    }

    if (result.length === 0) {
      return res.status(400).send('User not found');
    }

    const user = result[0];

    bcrypt.compare(password, user.password, (err, isMatch) => {
      if (err) {
        return res.status(500).send('Server error');
      }

      if (!isMatch) {
        return res.status(400).send('Invalid credentials');
      }

      res.status(200).redirect('/dashboard');
    });
  });
});

// Render login page
app.get('/login', (req, res) => {
  res.render('login');
});

// Render register page
app.get('/register', (req, res) => {
  res.render('register');
});

// Render add-device page
app.get('/add-device', (req, res) => {
  res.render('add-device');
});

// Render upload-capture page
app.get('/upload-capture', (req, res) => {
  res.render('upload-capture');
});

// Endpoint to handle image upload
app.post('/upload-image', (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      res.send('Error uploading file.');
    } else {
      if (req.file == undefined) {
        res.send('No file selected.');
      } else {
        res.send(`File uploaded successfully: <a href="/uploads/${req.file.filename}">${req.file.filename}</a>`);
      }
    }
  });
});

// Start Express server
let server;
function startServer() {
  server = app.listen(port, () => {
    console.log(`Express server running at http://localhost:${port}`);
  });

  // Error handling for port in use
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} is in use, trying another port...`);
      port++;
      startServer();
    } else {
      console.error(err);
    }
  });
}

startServer();
