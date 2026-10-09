import React, { useState } from 'react';
import { ethers } from 'ethers';
import axios from 'axios';
import { UploadCloud, ShieldCheck, Lock, User, Briefcase, Search } from 'lucide-react';

// --- CONFIGURATION ---
// ⚠️ PASTE YOUR REAL CONTRACT ADDRESS HERE ⚠️
const CONTRACT_ADDRESS = "0x1477EE05dceBdb88Fbc49d6b0C2c5F5De7051ea3"; 

const ABI = [
	{ "inputs": [{ "internalType": "string", "name": "_hash", "type": "string" }], "name": "addDocument", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
	{ "inputs": [{ "internalType": "string", "name": "_hash", "type": "string" }], "name": "verifyDocument", "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }, { "internalType": "uint256", "name": "", "type": "uint256" }, { "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }
];

// 1. PUBLIC VERIFICATION PORTAL (Matches your "Citizen Verification Console" image)
const PublicVerification = ({ goBack }) => {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState(null);

  const verifyDoc = async () => {
    if(!file) return;
    setStatus("Processing Forensic Analysis...");
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await axios.post("http://localhost:5000/upload", formData);
      const autoHash = res.data.hash;

      if (!window.ethereum) return alert("Please install MetaMask!");
      const provider = new ethers.BrowserProvider(window.ethereum);
      const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
      const data = await contract.verifyDocument(autoHash);
      
      setResult({
        isValid: data[0],
        timestamp: new Date(Number(data[1]) * 1000).toLocaleString(),
        uploader: data[2]
      });
      setStatus(""); 

    } catch (err) {
      console.error(err);
      setStatus("");
      setResult({ isValid: false });
    }
  };

  return (
    <div className="min-h-screen bg-[#344155] flex flex-col items-center justify-center font-sans p-4">
      <div className="w-full max-w-lg">
        <button onClick={goBack} className="text-slate-300 hover:text-white mb-4 font-medium">← Logout</button>
        
        <div className="bg-white rounded-xl shadow-2xl p-8">
          <div className="flex items-center gap-3 mb-6">
            <ShieldCheck className="w-8 h-8 text-slate-700" />
            <h1 className="text-2xl font-bold text-slate-800">Citizen Verification Console</h1>
          </div>

          <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 mb-6 bg-slate-50 text-center">
            <p className="text-slate-600 font-semibold mb-3">Upload Suspect Document</p>
            <input 
                type="file" 
                onChange={(e) => setFile(e.target.files[0])} 
                className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-slate-600 file:text-white hover:file:bg-slate-700 cursor-pointer mx-auto"
            />
          </div>

          <button 
            onClick={verifyDoc}
            className="w-full bg-[#344155] text-white py-3 rounded-lg font-bold text-lg hover:bg-slate-700 transition"
          >
            Verify Integrity
          </button>

          {status && <p className="mt-4 text-center text-slate-500 animate-pulse">{status}</p>}

          {result && (
            <div className={`mt-6 p-4 rounded-lg text-center border ${result.isValid ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
              {result.isValid ? (
                <>
                  <h2 className="text-xl font-bold">✅ VERIFIED AUTHENTIC</h2>
                  <p className="text-sm mt-1">Issued: {result.timestamp}</p>
                </>
              ) : (
                <>
                  <h2 className="text-xl font-bold">⚠️ FAKE DOCUMENT</h2>
                  <p className="text-sm mt-1">No match found in blockchain.</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// 2. OFFICER UPLOAD PORTAL (Matches your "Secure Document Upload" image)
const OfficerUpload = ({ goBack }) => {
  // cloud interaction
  const [file, setFile] = useState(null);
  const [hash, setHash] = useState("");
  const [status, setStatus] = useState("");

  const handleUpload = async () => {
    if (!file) return;
    setStatus("Uploading to Cloud Vault...");
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await axios.post("http://localhost:5000/upload", formData);
      setHash(res.data.hash);
      setStatus("Cloud Upload Complete.");
    } catch (err) { setStatus("Upload Failed."); }
  };

  // blockchain interaction
  const saveToBlockchain = async () => {
    setStatus("Requesting Wallet Signature...");
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
      
      const tx = await contract.addDocument(hash);
      setStatus("Mining Transaction...");
      await tx.wait();
      
      setStatus(`🎉 SUCCESS! Document Registered.`);
    } catch (err) {
      if (JSON.stringify(err).includes("Document already exists")) {
        alert("⚠️ WARNING: This document is ALREADY registered!");
        window.location.reload(); 
        return;
      }
      setStatus("Error: " + err.message);
    }
  };

  return (
    <div className="min-h-screen bg-[#344155] flex flex-col items-center justify-center font-sans p-4">
      <div className="w-full max-w-lg">
        <button onClick={goBack} className="text-slate-300 hover:text-white mb-4 font-medium">← Logout</button>

        <div className="bg-white rounded-xl shadow-2xl p-8">
          <div className="flex items-center gap-3 mb-6">
            <UploadCloud className="w-8 h-8 text-slate-800" />
            <h1 className="text-2xl font-bold text-slate-800">Secure Document Upload</h1>
          </div>

          <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 mb-6 bg-slate-50 text-center">
             <input 
                type="file" 
                onChange={(e) => setFile(e.target.files[0])} 
                className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-slate-600 file:text-white hover:file:bg-slate-700 cursor-pointer"
            />
          </div>

          <button onClick={handleUpload} className="w-full bg-[#111827] text-white py-3 rounded-lg font-bold mb-3 hover:bg-black transition">
            1. Upload to Cloud Vault
          </button>

          {hash && (
            <button onClick={saveToBlockchain} className="w-full bg-green-600 text-white py-3 rounded-lg font-bold hover:bg-green-700 transition flex justify-center items-center gap-2">
              <Lock className="w-4 h-4"/> 2. Sign & Issue on Chain
            </button>
          )}

          {status && <p className="mt-4 text-center text-slate-600 font-medium">{status}</p>}
        </div>
      </div>
    </div>
  );
};

// 3. MAIN HOME SCREEN (Matches your "MindForge" dual card image)
function App() {
  const [view, setView] = useState('home');
  const [password, setPassword] = useState("");

  const handleLogin = () => {
    if (password === "admin123") setView('officer-upload');
    else alert("Incorrect PIN");
  };

  return (
    <>
      {view === 'home' && (
        <div className="min-h-screen bg-[#344155] flex flex-col items-center justify-center p-4 font-sans text-white">
          
          <div className="text-center mb-12">
            <h1 className="text-5xl font-extrabold mb-2 tracking-tight">MindForge</h1>
            <p className="text-slate-300 text-lg">Secure Document Verification System</p>
          </div>

          <div className="grid md:grid-cols-2 gap-8 w-full max-w-4xl">
            
            {/* Card 1: Citizen (Public) */}
            <div className="bg-[#1e293b] p-8 rounded-2xl border border-slate-700 shadow-xl hover:shadow-2xl transition">
              <div className="w-12 h-12 bg-purple-500/20 rounded-full flex items-center justify-center mb-4">
                <User className="w-6 h-6 text-purple-400" />
              </div>
              <h2 className="text-2xl font-bold mb-2">Citizen Portal</h2>
              <p className="text-slate-400 mb-6 text-sm">Upload documents to verify authenticity against the blockchain vault.</p>
              <button onClick={() => setView('public-verify')} className="w-full bg-slate-200 text-slate-900 py-3 rounded-lg font-bold hover:bg-white transition">
                Access as Citizen
              </button>
            </div>

            {/* Card 2: Officer (Private) */}
            <div className="bg-[#1e293b] p-8 rounded-2xl border border-slate-700 shadow-xl hover:shadow-2xl transition">
               <div className="w-12 h-12 bg-blue-500/20 rounded-full flex items-center justify-center mb-4">
                <Briefcase className="w-6 h-6 text-blue-400" />
              </div>
              <h2 className="text-2xl font-bold mb-2">Officer Portal</h2>
              <p className="text-slate-400 mb-6 text-sm">Verify documents and audit records. (Restricted Access)</p>
              
              <div className="flex gap-2">
                <input 
                  type="password" 
                  placeholder="Enter Officer PIN" 
                  className="bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white w-full focus:outline-none focus:border-blue-500"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <button onClick={handleLogin} className="w-full mt-3 bg-slate-200 text-slate-900 py-3 rounded-lg font-bold hover:bg-white transition">
                Verify Identity
              </button>
            </div>

          </div>
        </div>
      )}

      {view === 'public-verify' && <PublicVerification goBack={() => setView('home')} />}
      {view === 'officer-upload' && <OfficerUpload goBack={() => { setView('home'); setPassword(""); }} />}
    </>
  );
}

export default App;