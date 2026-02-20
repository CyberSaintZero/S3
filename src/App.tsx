import React, { useState, useMemo, useCallback, useRef } from 'react';
import Papa from 'papaparse';
import { 
  Upload, 
  FileText, 
  Trash2, 
  ShieldCheck, 
  Activity, 
  Search, 
  Filter,
  CheckCircle2,
  AlertCircle,
  Database,
  ArrowUpDown,
  Laptop,
  X,
  Plus,
  Download
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ImageWithFallback } from './components/figma/ImageWithFallback';
import logoImg from 'figma:asset/c92742c70865c0f780c46d324d3b0713d3fbfcdc.png';

// --- Types ---
interface CSVSource {
  id: string;
  name: string;
  label: string;
  fileName: string;
  data: any[];
  headers: string[];
  color: string;
}

interface PendingFile {
  id: string;
  file: File;
  label: string;
}

interface SourceDetail {
  sourceId: string;
  sourceLabel: string;
  sourceColor: string;
  data: Record<string, any>;
}

interface NormalizedAsset {
  id: string; // The primary matching key (MAC, Hostname, or IP)
  mac?: string;
  hostname?: string;
  ip?: string;
  manufacturer?: string;
  sources: Set<string>; // Source IDs where this asset was found
  sourceDetails: SourceDetail[]; // Collection of raw data from each matching source
}

// --- Utilities ---
const COLORS = [
  'bg-[#0B5AA8]', // Logo Dark Blue
  'bg-[#40A7DB]', // Logo Light Blue
  'bg-emerald-600', 
  'bg-amber-600', 
  'bg-rose-600', 
  'bg-indigo-600',
  'bg-cyan-600', 
  'bg-orange-600', 
  'bg-teal-600', 
  'bg-violet-600'
];

const normalizeMAC = (mac: any): string | null => {
  if (!mac || typeof mac !== 'string') return null;
  const clean = mac.replace(/[:\-\.]/g, '').toLowerCase().trim();
  if (clean.length !== 12) return null;
  // Filter out common "garbage" MACs
  if (/^(0+|f+)$/.test(clean)) return null;
  return clean;
};

const normalizeHostname = (name: any): string | null => {
  if (!name || typeof name !== 'string') return null;
  const clean = name.toLowerCase().trim();
  if (!clean || clean === 'null' || clean === 'undefined' || clean === 'unknown') return null;
  return clean;
};

const normalizeIP = (ip: any): string | null => {
  if (!ip || typeof ip !== 'string') return null;
  const clean = ip.trim();
  if (!clean || clean === '0.0.0.0' || clean === '127.0.0.1') return null;
  // Basic IP check
  return /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(clean) ? clean : null;
};

const formatMAC = (normalized: string | null | undefined): string => {
  if (!normalized || normalized.length !== 12) return '—';
  const parts = normalized.match(/.{1,2}/g);
  return parts ? parts.join(':').toUpperCase() : normalized.toUpperCase();
};

const getRowValue = (row: any, patterns: string[]): string | null => {
  const keys = Object.keys(row);
  const foundKey = keys.find(k => {
    const cleanK = k.toLowerCase().replace(/[\s\-_]/g, '');
    return patterns.some(p => cleanK === p.toLowerCase().replace(/[\s\-_]/g, ''));
  });
  
  if (!foundKey) return null;
  const val = row[foundKey];
  if (val === null || val === undefined) return null;
  const strVal = String(val).trim();
  return strVal === '' ? null : strVal;
};

export default function App() {
  const [sources, setSources] = useState<CSVSource[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const [crossoverFilter, setCrossoverFilter] = useState<'all' | 'unique' | 'multiple'>('all');
  
  // --- New State for Tagging Workflow ---
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [showImportModal, setShowImportModal] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<NormalizedAsset | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Export Logic ---
  const exportResults = () => {
    if (filteredAssets.length === 0) return;

    // Prepare data for export
    const exportData = filteredAssets.map(asset => ({
      Status: asset.sources.size > 1 ? 'Synced' : 'Unique',
      'Primary Identifier': asset.mac ? formatMAC(asset.mac) : asset.id,
      'Match Type': asset.mac ? 'MAC' : asset.hostname ? 'HOSTNAME' : 'IP',
      Hostname: asset.hostname || '',
      IP: asset.ip || '',
      Manufacturer: asset.manufacturer || 'Unknown',
      'Sources Count': asset.sources.size,
      'Sources List': Array.from(asset.sources).map(id => sources.find(s => s.id === id)?.label).join(', ')
    }));

    const csv = Papa.unparse(exportData);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `AssetLink_Export_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // --- Handlers ---
  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement> | React.DragEvent) => {
    let files: FileList | null = null;
    
    if ('files' in e.target && e.target.files) {
      files = e.target.files;
    } else if ('dataTransfer' in e) {
      e.preventDefault();
      files = e.dataTransfer.files;
    }

    if (!files || files.length === 0) return;

    const newPending = Array.from(files)
      .filter(f => f.name.toLowerCase().endsWith('.csv'))
      .map(f => ({
        id: Math.random().toString(36).substr(2, 9),
        file: f,
        label: f.name.replace(/\.[^/.]+$/, "")
      }));

    if (newPending.length > 0) {
      setPendingFiles(prev => [...prev, ...newPending]);
      setShowImportModal(true);
    }
    
    // Reset input value so same file can be selected again if needed
    if ('value' in e.target) {
      e.target.value = '';
    }
  };

  const processImport = () => {
    if (pendingFiles.length === 0) return;
    setIsProcessing(true);
    let completedCount = 0;
    const newSources: CSVSource[] = [];

    // Snapshot of pending files to avoid race conditions
    const filesToProcess = [...pendingFiles];

    filesToProcess.forEach((pending) => {
      Papa.parse(pending.file, {
        header: true,
        skipEmptyLines: 'greedy',
        // Removing worker: true because functions in transformHeader cannot be cloned to workers
        transformHeader: (header) => header.trim(),
        complete: (results) => {
          const cleanData = results.data.filter((row: any) => {
            return Object.values(row).some(v => v !== null && v !== '' && v !== undefined);
          });

          newSources.push({
            id: pending.id,
            name: pending.file.name.replace(/\.[^/.]+$/, ""),
            label: pending.label || pending.file.name.replace(/\.[^/.]+$/, ""),
            fileName: pending.file.name,
            data: cleanData,
            headers: results.meta.fields || [],
            color: COLORS[(sources.length + newSources.length) % COLORS.length]
          });
          
          completedCount++;
          if (completedCount === filesToProcess.length) {
            setSources(prev => {
              const combined = [...prev, ...newSources];
              return combined.slice(0, 10);
            });
            setIsProcessing(false);
            setPendingFiles([]);
            setShowImportModal(false);
          }
        },
        error: (err) => {
          console.error("CSV Parse Error:", err);
          completedCount++;
          if (completedCount === filesToProcess.length) {
            setSources(prev => [...prev, ...newSources]);
            setIsProcessing(false);
            setPendingFiles([]);
            setShowImportModal(false);
          }
        }
      });
    });
  };

  const removeSource = (id: string) => {
    setSources(prev => prev.filter(s => s.id !== id));
  };

  const updateSourceLabel = (id: string, label: string) => {
    setSources(prev => prev.map(s => s.id === id ? { ...s, label } : s));
  };

  // --- Core Logic: Cross-CSV Evaluation (Identity Resolution) ---
  const aggregatedAssets = useMemo(() => {
    const assets: NormalizedAsset[] = [];
    // Maps for fast lookup
    const macMap = new Map<string, number>(); // mac -> index in assets array
    const hostMap = new Map<string, number>(); // host -> index
    const ipMap = new Map<string, number>(); // ip -> index
    const idMap = new Map<string, number>(); // generic id -> index

    const MAC_HEADERS = ['mac', 'macaddress', 'physicaladdress', 'ethernet', 'hwaddress', 'hardwareaddress', 'physical'];
    const HOST_HEADERS = ['hostname', 'host', 'computername', 'name', 'assetname', 'devicename', 'systemname', 'computer', 'device', 'system'];
    const IP_HEADERS = ['ip', 'ipaddress', 'ipv4', 'address', 'ipv4address', 'internetaddress', 'ipaddr'];
    const ID_HEADERS = ['id', 'assetid', 'serial', 'serialnumber', 'tag', 'assettag'];
    const MANUFACTURER_HEADERS = ['manufacturer', 'mfg', 'vendor', 'make', 'devicevendor', 'hardwarevendor', 'manuf'];

    sources.forEach(source => {
      source.data.forEach(row => {
        const normMac = normalizeMAC(getRowValue(row, MAC_HEADERS));
        const normHost = normalizeHostname(getRowValue(row, HOST_HEADERS));
        const normIP = normalizeIP(getRowValue(row, IP_HEADERS));
        const normID = getRowValue(row, ID_HEADERS);
        const normManuf = getRowValue(row, MANUFACTURER_HEADERS);

        if (!normMac && !normHost && !normIP && !normID) return;

        // Identity Resolution Strategy:
        // Check MAC first, then Hostname, then IP, then generic ID
        let existingIdx = -1;
        if (normMac && macMap.has(normMac)) {
          existingIdx = macMap.get(normMac)!;
        } else if (normHost && hostMap.has(normHost)) {
          existingIdx = hostMap.get(normHost)!;
        } else if (normIP && ipMap.has(normIP)) {
          existingIdx = ipMap.get(normIP)!;
        } else if (normID && idMap.has(normID)) {
          existingIdx = idMap.get(normID)!;
        }

        if (existingIdx !== -1) {
          // Update existing asset
          const asset = assets[existingIdx];
          asset.sources.add(source.id);
          asset.sourceDetails.push({
            sourceId: source.id,
            sourceLabel: source.label,
            sourceColor: source.color,
            data: { ...row }
          });
          if (!asset.mac && normMac) {
            asset.mac = normMac;
            macMap.set(normMac, existingIdx);
          }
          if (!asset.hostname && normHost) {
            asset.hostname = normHost;
            hostMap.set(normHost, existingIdx);
          }
          if (!asset.ip && normIP) {
            asset.ip = normIP;
            ipMap.set(normIP, existingIdx);
          }
          if (!asset.manufacturer && normManuf) {
            asset.manufacturer = normManuf;
          }
        } else {
          // Create new asset
          const newIdx = assets.length;
          const newAsset: NormalizedAsset = {
            id: normMac || normHost || normIP || normID || Math.random().toString(),
            mac: normMac || undefined,
            hostname: normHost || undefined,
            ip: normIP || undefined,
            manufacturer: normManuf || undefined,
            sources: new Set([source.id]),
            sourceDetails: [{
              sourceId: source.id,
              sourceLabel: source.label,
              sourceColor: source.color,
              data: { ...row }
            }]
          };
          assets.push(newAsset);
          if (normMac) macMap.set(normMac, newIdx);
          if (normHost) hostMap.set(normHost, newIdx);
          if (normIP) ipMap.set(normIP, newIdx);
          if (normID) idMap.set(normID, newIdx);
        }
      });
    });

    return assets;
  }, [sources]);

  // --- Filtering ---
  const filteredAssets = useMemo(() => {
    const lowerSearch = searchTerm.toLowerCase().trim();
    const cleanSearch = searchTerm.replace(/[:\-\.]/g, '').toLowerCase().trim();
    
    return aggregatedAssets.filter(asset => {
      // Text search
      const matchesSearch = searchTerm === '' || 
        (asset.mac && asset.mac.includes(cleanSearch)) ||
        (asset.hostname && asset.hostname.toLowerCase().includes(lowerSearch)) ||
        (asset.ip && asset.ip.toLowerCase().includes(lowerSearch)) ||
        (asset.manufacturer && asset.manufacturer.toLowerCase().includes(lowerSearch)) ||
        (asset.id && asset.id.toLowerCase().includes(lowerSearch));

      // Source Filter
      const matchesSource = activeFilters.length === 0 || 
        activeFilters.some(id => asset.sources.has(id));

      // Crossover Filter
      let matchesCrossover = true;
      if (crossoverFilter === 'unique') {
        matchesCrossover = asset.sources.size === 1;
      } else if (crossoverFilter === 'multiple') {
        matchesCrossover = asset.sources.size > 1;
      }

      return matchesSearch && matchesSource && matchesCrossover;
    });
  }, [aggregatedAssets, searchTerm, activeFilters, crossoverFilter]);

  const toggleSourceFilter = (id: string) => {
    setActiveFilters(prev => 
      prev.includes(id) ? prev.filter(f => f !== id) : [...prev, id]
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-[1600px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 flex items-center justify-center">
              <ImageWithFallback src={logoImg} className="w-full h-full object-contain" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-[#0B5AA8]">AssetLink</h1>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Cross-CSV Inventory Auditor</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-full text-sm font-medium">
              <Activity className="w-4 h-4 text-[#40A7DB]" />
              <span>{aggregatedAssets.length.toLocaleString()} Assets Identified</span>
            </div>
            {filteredAssets.length > 0 && (
              <button 
                onClick={exportResults}
                className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-lg flex items-center gap-2 transition-colors shadow-sm text-sm font-semibold"
              >
                <Download className="w-4 h-4" />
                Export Results
              </button>
            )}
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="bg-[#0B5AA8] hover:bg-[#004B9B] text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors shadow-sm text-sm font-semibold"
            >
              <Upload className="w-4 h-4" />
              Import CSV
              <input 
                ref={fileInputRef}
                type="file" 
                multiple 
                accept=".csv" 
                onChange={onFileSelect} 
                className="hidden" 
              />
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-[1600px] mx-auto px-6 py-8 flex gap-8">
        {/* Sidebar: Source Management */}
        <aside className="w-80 shrink-0 space-y-6">
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-slate-500 uppercase flex items-center gap-2">
                <Database className="w-4 h-4" />
                Data Sources ({sources.length}/10)
              </h2>
            </div>
            <div 
              className="space-y-3"
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onFileSelect(e);
              }}
            >
              {sources.length === 0 && (
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-slate-200 hover:border-[#40A7DB] hover:bg-[#40A7DB]/5 rounded-xl p-6 text-center transition-all cursor-pointer group"
                >
                  <FileText className="w-8 h-8 text-slate-300 group-hover:text-[#40A7DB] mx-auto mb-2 transition-colors" />
                  <p className="text-sm text-slate-400 font-medium group-hover:text-[#0B5AA8]">Drop CSV files here or click to browse.</p>
                </div>
              )}
              {sources.map((source) => (
                <div 
                  key={source.id} 
                  className={`bg-white border transition-all rounded-xl p-4 shadow-sm group ${
                    activeFilters.includes(source.id) 
                      ? 'border-[#0B5AA8] ring-1 ring-[#0B5AA8] bg-[#0B5AA8]/5' 
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className={`w-3 h-3 rounded-full ${source.color}`} />
                    <button 
                      onClick={() => removeSource(source.id)}
                      className="text-slate-400 hover:text-rose-500 p-1 rounded-md hover:bg-rose-50 transition-all opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <input 
                    type="text" 
                    value={source.label}
                    onChange={(e) => updateSourceLabel(source.id, e.target.value)}
                    className="w-full bg-transparent font-bold text-slate-800 border-none p-0 focus:ring-0 mb-1"
                    placeholder="Source Label"
                  />
                  <div className="flex items-center justify-between text-[11px] text-slate-400 uppercase font-bold tracking-tight mb-3">
                    <span className="truncate max-w-[120px]">{source.fileName}</span>
                  </div>
                  
                  <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                    <button 
                      onClick={() => toggleSourceFilter(source.id)}
                      className={`flex-1 text-[10px] font-bold py-1.5 rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                        activeFilters.includes(source.id) 
                          ? 'bg-[#0B5AA8] text-white shadow-sm' 
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {activeFilters.includes(source.id) ? (
                        <>
                          <CheckCircle2 className="w-3 h-3" />
                          FILTERING
                        </>
                      ) : (
                        <>
                          <Filter className="w-3 h-3" />
                          FILTER BY {source.label.toUpperCase()}
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Quick Stats */}
          {sources.length > 0 && (
            <section className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <h3 className="text-xs font-bold text-slate-400 uppercase mb-4 tracking-widest">Audit Summary</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">Cross-Source Assets</span>
                  <span className="text-sm font-bold text-[#0B5AA8]">
                    {aggregatedAssets.filter(a => a.sources.size > 1).length}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">Unique to Single Source</span>
                  <span className="text-sm font-bold text-slate-800">
                    {aggregatedAssets.filter(a => a.sources.size === 1).length}
                  </span>
                </div>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden flex">
                  {sources.map(s => (
                    <div 
                      key={s.id}
                      className={s.color}
                      style={{ width: `${(aggregatedAssets.filter(a => a.sources.has(s.id)).length / aggregatedAssets.length) * 100}%` }}
                    />
                  ))}
                </div>
              </div>
            </section>
          )}
        </aside>

        {/* Main Content: Results & Filters */}
        <main className="flex-1 min-w-0 space-y-6">
          {/* Controls Bar */}
          <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-4">
            <div className="flex items-center gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input 
                  type="text" 
                  placeholder="Search by MAC, Hostname, or IP..."
                  className="w-full pl-10 pr-4 py-2 bg-slate-50 border-none rounded-xl focus:ring-2 focus:ring-[#40A7DB] text-sm"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <div className="flex bg-slate-50 p-1 rounded-xl">
                <button 
                  onClick={() => setCrossoverFilter('all')}
                  className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${crossoverFilter === 'all' ? 'bg-white shadow-sm text-[#0B5AA8]' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  ALL
                </button>
                <button 
                  onClick={() => setCrossoverFilter('multiple')}
                  className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${crossoverFilter === 'multiple' ? 'bg-white shadow-sm text-[#0B5AA8]' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  SHARED
                </button>
                <button 
                  onClick={() => setCrossoverFilter('unique')}
                  className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${crossoverFilter === 'unique' ? 'bg-white shadow-sm text-[#0B5AA8]' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  UNIQUE
                </button>
              </div>
            </div>

            {/* Source Pill Filters */}
            <div className="flex flex-wrap items-center gap-2">
              <Filter className="w-4 h-4 text-slate-400 mr-2" />
              {sources.map(source => (
                <button
                  key={source.id}
                  onClick={() => toggleSourceFilter(source.id)}
                  className={`px-3 py-1 rounded-full text-[11px] font-bold uppercase transition-all flex items-center gap-2 ${
                    activeFilters.includes(source.id) 
                      ? `${source.color} text-white` 
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  {source.label}
                  {activeFilters.includes(source.id) && <CheckCircle2 className="w-3 h-3" />}
                </button>
              ))}
              {activeFilters.length > 0 && (
                <button 
                  onClick={() => setActiveFilters([])}
                  className="text-[11px] font-bold text-rose-500 hover:underline px-2"
                >
                  CLEAR FILTERS
                </button>
              )}
            </div>
          </div>

          {/* Results Table */}
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-6 py-4 text-[11px] font-bold text-slate-400 uppercase tracking-widest">Status</th>
                    <th className="px-6 py-4 text-[11px] font-bold text-slate-400 uppercase tracking-widest">Primary Identifier</th>
                    <th className="px-6 py-4 text-[11px] font-bold text-slate-400 uppercase tracking-widest">Hostname / IP</th>
                    <th className="px-6 py-4 text-[11px] font-bold text-slate-400 uppercase tracking-widest">Manufacturer</th>
                    <th className="px-6 py-4 text-[11px] font-bold text-slate-400 uppercase tracking-widest">Sources Found In</th>
                    <th className="px-6 py-4 text-[11px] font-bold text-slate-400 uppercase tracking-widest text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredAssets.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-20 text-center">
                        <div className="max-w-xs mx-auto">
                          <AlertCircle className="w-10 h-10 text-slate-200 mx-auto mb-4" />
                          <p className="text-slate-400 font-medium text-sm">No matching assets found. Try adjusting your filters or importing more data.</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredAssets.slice(0, 500).map((asset) => (
                      <tr key={asset.id} className="hover:bg-slate-50/50 transition-colors group">
                        <td className="px-6 py-4">
                          {asset.sources.size > 1 ? (
                            <div className="flex items-center gap-1.5 text-[#40A7DB] text-xs font-bold uppercase">
                              <CheckCircle2 className="w-4 h-4" />
                              Synced
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 text-slate-400 text-xs font-bold uppercase">
                              <AlertCircle className="w-4 h-4" />
                              Unique
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <div className="font-mono text-sm text-slate-700 bg-slate-100 px-2 py-1 rounded inline-block">
                            {asset.mac ? formatMAC(asset.mac) : asset.id}
                          </div>
                          <div className="text-[10px] text-slate-400 font-bold mt-1 uppercase">
                            MATCHED BY: {asset.mac ? 'MAC' : asset.hostname ? 'HOSTNAME' : 'IP'}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col">
                            <span className="text-sm font-semibold text-slate-800">{asset.hostname || '—'}</span>
                            <span className="text-xs text-slate-500 font-mono">{asset.ip || '—'}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-xs font-medium text-slate-600 bg-slate-50 px-2 py-1 rounded border border-slate-100">
                            {asset.manufacturer || 'Unknown'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex -space-x-2 overflow-hidden">
                            {Array.from(asset.sources).map(sourceId => {
                              const src = sources.find(s => s.id === sourceId);
                              return (
                                <div 
                                  key={sourceId}
                                  title={src?.label}
                                  className={`w-8 h-8 rounded-full border-2 border-white flex items-center justify-center text-[10px] font-bold text-white shadow-sm cursor-help ${src?.color || 'bg-slate-400'}`}
                                >
                                  {src?.label.charAt(0).toUpperCase()}
                                </div>
                              );
                            })}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button 
                            onClick={() => setSelectedAsset(asset)}
                            className="text-[#0B5AA8] hover:text-[#004B9B] text-xs font-bold transition-colors opacity-0 group-hover:opacity-100"
                          >
                            VIEW DETAILS
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {filteredAssets.length > 500 && (
              <div className="px-6 py-4 bg-slate-50 text-center border-t border-slate-200">
                <p className="text-xs text-slate-500 font-medium">
                  Showing first 500 of {filteredAssets.length.toLocaleString()} matching results. Use search to narrow down further.
                </p>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {/* Import & Tagging Modal */}
        {showImportModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
              onClick={() => !isProcessing && setShowImportModal(false)}
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                <h2 className="text-lg font-bold text-slate-800">Identify Data Sources</h2>
                {!isProcessing && (
                  <button 
                    onClick={() => setShowImportModal(false)}
                    className="p-2 hover:bg-slate-200 rounded-full transition-colors"
                  >
                    <X className="w-5 h-5 text-slate-500" />
                  </button>
                )}
              </div>
              
              <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
                <p className="text-sm text-slate-500 mb-4">
                  Assign a unique tag for each CSV file. This label will be used to identify assets originating from this specific source.
                </p>
                {pendingFiles.map((pf) => (
                  <div key={pf.id} className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex gap-4 items-start">
                    <div className="bg-white p-2 rounded-lg border border-slate-200 shadow-sm">
                      <FileText className="w-6 h-6 text-[#0B5AA8]" />
                    </div>
                    <div className="flex-1 space-y-2">
                      <div className="text-[10px] font-bold text-slate-400 uppercase truncate">
                        {pf.file.name}
                      </div>
                      <input 
                        type="text"
                        value={pf.label}
                        placeholder="e.g. Ordr, CrowdStrike, SentinelOne"
                        onChange={(e) => {
                          const val = e.target.value;
                          setPendingFiles(prev => prev.map(p => p.id === pf.id ? { ...p, label: val } : p));
                        }}
                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-[#40A7DB] transition-all outline-none"
                        autoFocus
                      />
                    </div>
                    <button 
                      onClick={() => setPendingFiles(prev => prev.filter(p => p.id !== pf.id))}
                      className="p-1 hover:text-rose-500 text-slate-400 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}

                {pendingFiles.length === 0 && (
                   <div className="text-center py-8">
                     <p className="text-sm text-slate-400">All files removed.</p>
                   </div>
                )}
              </div>

              <div className="p-6 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                <div className="text-xs font-medium text-slate-500">
                  {pendingFiles.length} file(s) selected
                </div>
                <div className="flex gap-3">
                  <button 
                    disabled={isProcessing}
                    onClick={() => setShowImportModal(false)}
                    className="px-4 py-2 text-sm font-bold text-slate-600 hover:text-slate-800 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button 
                    disabled={isProcessing || pendingFiles.length === 0}
                    onClick={processImport}
                    className="px-6 py-2 bg-[#0B5AA8] hover:bg-[#004B9B] text-white rounded-lg text-sm font-bold shadow-sm transition-all flex items-center gap-2 disabled:opacity-50"
                  >
                    {isProcessing ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Processing...
                      </>
                    ) : (
                      <>
                        <Plus className="w-4 h-4" />
                        Add to Workspace
                      </>
                    )}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {/* Asset Details Modal */}
        {selectedAsset && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
              onClick={() => setSelectedAsset(null)}
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative w-full max-w-4xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50 shrink-0">
                <div className="flex items-center gap-4">
                  <div className="bg-[#0B5AA8] p-2 rounded-lg">
                    <Laptop className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-slate-800">Asset Identity Profile</h2>
                    <p className="text-xs text-slate-500 font-mono uppercase">{selectedAsset.id}</p>
                  </div>
                </div>
                <button 
                  onClick={() => setSelectedAsset(null)}
                  className="p-2 hover:bg-slate-200 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-slate-500" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-8">
                {/* Identity Header */}
                <div className="grid grid-cols-3 gap-6">
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                    <span className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Standardized MAC</span>
                    <span className="text-sm font-mono font-bold text-slate-800">{formatMAC(selectedAsset.mac)}</span>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                    <span className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Resolved Hostname</span>
                    <span className="text-sm font-bold text-slate-800">{selectedAsset.hostname || 'UNRESOLVED'}</span>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                    <span className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Resolved IP Address</span>
                    <span className="text-sm font-mono font-bold text-slate-800">{selectedAsset.ip || 'UNRESOLVED'}</span>
                  </div>
                </div>

                {/* Source Records */}
                <div className="space-y-4">
                  <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                    <Database className="w-4 h-4" />
                    Source Records ({selectedAsset.sourceDetails.length})
                  </h3>
                  
                  <div className="space-y-6">
                    {selectedAsset.sourceDetails.map((detail, idx) => (
                      <div key={`${detail.sourceId}-${idx}`} className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                        <div className={`px-4 py-2 flex items-center justify-between ${detail.sourceColor} text-white`}>
                          <span className="text-xs font-bold uppercase tracking-wider">{detail.sourceLabel}</span>
                          <span className="text-[10px] opacity-80">RAW CSV DATA</span>
                        </div>
                        <div className="p-4 bg-white grid grid-cols-2 md:grid-cols-3 gap-y-3 gap-x-6">
                          {Object.entries(detail.data).map(([key, value]) => (
                            <div key={key} className="min-w-0">
                              <span className="block text-[10px] font-bold text-slate-400 uppercase truncate mb-0.5">{key}</span>
                              <span className="block text-xs font-medium text-slate-700 truncate" title={String(value)}>
                                {String(value) || <span className="text-slate-300 italic">null</span>}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="p-6 bg-slate-50 border-t border-slate-100 flex justify-end shrink-0">
                <button 
                  onClick={() => setSelectedAsset(null)}
                  className="px-6 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-sm font-bold shadow-sm transition-all"
                >
                  Close Profile
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
