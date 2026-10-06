// Import WebSocket to avoid
import { WebSocketServer, WebSocket } from 'ws'
import { encode, decode } from '@msgpack/msgpack'
import { BrowserWindow, ipcMain } from 'electron'
import { networkInterfaces } from 'os'
import {
  initializeGamepadSystem,
  createGamepad,
  xboxInput,
  dualShockInput,
  releaseGamepad
} from './gamepadFactory'
import { GamepadData } from '../shared/types'
import { GamepadType } from '../shared/enums'
import { vigem_error } from './ffi'
import { getMaxConnections } from './index'
import { log, logThrottled, clearThrottle } from './logger'

interface WebSocketMessage {
  action: 'handshake_ack' | 'register_ack' | 'delay_test_request' | 'delay_test_end' | 'error'
  status: 'ok' | 'error'
  payload: string
}

interface ServerStatus {
  status: 'closed' | 'started' | 'error'
  message?: string
  error?: string
  shouldDownload?: boolean
}

type WebSocketGamepadPayload = {
  action: string
  id?: number

  gamepadType: string
  gamepadData?: GamepadData
  timestamp?: number
}

type WebSocketPingPayload = {
  action: string
  id: number

  timestamp: number
  payload: string
}

let wss: WebSocketServer | null = null
let mainWindow: BrowserWindow | null = null
let port: number = 60001 // Default port

interface ClientData {
  ip: string
  websocket: WebSocket
  clientId: number
  isTestingDelay: boolean
  T1: number
  T2: number
  T3: number
  T4: number
  rtt: number
}

const clientMap: Map<number, ClientData> = new Map() // Store client connections by ID

// Store all active communications in a Set
const connections = new Set<WebSocket>()

function newClientData(ip: string, websocket: WebSocket, clientId: number): ClientData {
  return {
    ip,
    websocket,
    clientId,
    isTestingDelay: false,
    T1: 0,
    T2: 0,
    T3: 0,
    T4: 0,
    rtt: 0
  }
}

function getLocalIpAddresses(): string[] {
  const nets = networkInterfaces();
  const results: string[] = [];

  for (const name of Object.keys(nets)) {
    // Filter out common virtual interfaces
    if (/(docker|lo|veth|br-|virbr|vmware|vmnet|tun|tap|vethernet)/i.test(name)) {
      continue;
    }
    const interfaces = nets[name];
    if (!interfaces) continue;

    for (const net of interfaces) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results;
}
function checkNetworkStatus(): boolean {
  const addresses = getLocalIpAddresses()
  return addresses.length > 0
}

function initWebSocketManager(window: BrowserWindow): void {
  mainWindow = window

  // Check network status initially
  const hasNetwork = checkNetworkStatus()
  if (!hasNetwork) {
    mainWindow?.webContents.send('server-status', {
      status: 'error',
      error: 'NO_NETWORK'
    } as ServerStatus)
    return
  }

  ipcMain.on('wss:start', (_, portNumber) => {
    startServer(portNumber)
  })

  ipcMain.on('wss:stop', () => {
    stopServer()
  })

  ipcMain.handle('wss:get_server_ip', () => {
    const ipAddresses = getLocalIpAddresses()
    if (ipAddresses.length === 0) {
      mainWindow?.webContents.send('server-status', {
        status: 'error',
        error: 'NO_NETWORK'
      } as ServerStatus)
      return {
        ips: [],
        port: port,
        isRunning: false
      }
    }
    return {
      ips: ipAddresses,
      port: port,
      isRunning: wss !== null
    }
  })

  window.on('close', () => {
    stopServer()
    mainWindow = null
  })
}

function startServer(portNumber?: number): void {
  // Check network status before starting server
  const hasNetwork = checkNetworkStatus()
  if (!hasNetwork) {
    mainWindow?.webContents.send('server-status', {
      status: 'error',
      error: 'NO_NETWORK'
    } as ServerStatus)
    return
  }

  if (wss) {
    // Stop the existing server if it's already running
    stopServer()
  }

  port = portNumber ? portNumber : port
  
  const tryStartServer = (currentPort: number) => {
    wss = new WebSocketServer({ port: currentPort })

    wss.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        log('warn', `Port ${currentPort} is in use, trying ${currentPort + 1}`)
        wss = null
        tryStartServer(currentPort + 1)
      } else {
        mainWindow?.webContents.send('server-status', {
          status: 'error',
          error: error.message
        } as ServerStatus)
        log('error', `WebSocket server error: ${error.message}`)
      }
    })

    wss.on('listening', async () => {
      port = currentPort
      log('info', `Server listening on port ${port} (${getLocalIpAddresses().join(', ')})`)
      const error = await initializeGamepadSystem()

      if (error === vigem_error.VIGEM_ERROR_NONE) {
        log('info', 'ViGEm initialized, server started');
        mainWindow?.webContents.send('server-status', {
          status: 'started',
          port: port
        })
      } else {
        if (error === vigem_error.VIGEM_ERROR_BUS_NOT_FOUND) {
          log('error', 'ViGEm bus not found (driver not installed?)');
          mainWindow?.webContents.send('server-status', {
            status: 'error',
            error: 'VIGEM_ERROR_BUS_NOT_FOUND',
            shouldDownload: true
          } as ServerStatus)
        } else {
          log('error', `ViGEm initialize failed: ${vigem_error[error] ?? error}`);
          mainWindow?.webContents.send('server-status', {
            status: 'error',
            error: 'Unknown'
          } as ServerStatus)
        }
        
        // 在发送错误状态后关闭 WebSocket 服务器
        wss?.close(() => {
          console.log('WebSocket server closed due to ViGEm error');
          wss = null;
        });
        return;
      }
    })

    wss.on('connection', (ws, req) => {
      const clientIp = req.socket.remoteAddress
      connections.add(ws)
      log('info', `Client connected: ${clientIp} (total ${connections.size})`)

      mainWindow?.webContents.send('client-connected', {
        ip: clientIp,
        totalConnections: connections.size
      })

      ws.on('message', (message) => {
        if (clientIp) {
          handleWebSocketMessage(ws, message, clientIp)
        } else {
          const response: WebSocketMessage = {
            action: 'error',
            status: 'error',
            payload: 'Unknown client IP'
          }
          ws.send(encode(response))
        }
      })

      ws.on('close', (code) => {
        // Unregistered sockets must leave the set too, or they eat max-connection slots.
        connections.delete(ws)
        let releasedId: number | null = null
        for (const [id, data] of clientMap.entries()) {
          const _ws = data.websocket
          if (_ws === ws) {
            releaseGamepad(data.clientId)
            mainWindow?.webContents.send('gamepad:disconnected', { id: data.clientId })
            clientMap.delete(id)
            clearThrottle(`client:${id}:`)
            releasedId = id
            break
          }
        }
        log('info', `Client closed: ${clientIp} code=${code} gamepad=${releasedId ?? 'none'} (total ${connections.size})`)
      })
    })
  }

  tryStartServer(port)
}

function stopServer() {
  if (wss) {
    for (const connection of connections) {
      connection.close()
    }
  }

  connections.clear()

  wss?.close(() => {
    mainWindow?.webContents.send('server-status', {
      status: 'closed'
    } as ServerStatus)

    wss = null
  })
}

async function handleWebSocketMessage(ws: WebSocket, message: any, clientIp: string) {
  let decoded: WebSocketGamepadPayload | WebSocketPingPayload
  try {
    decoded = decode(message) as WebSocketGamepadPayload | WebSocketPingPayload
  } catch (err) {
    const bytes = Buffer.isBuffer(message) ? message : Buffer.from(message as ArrayBuffer)
    logThrottled(
      `decode:${clientIp}`,
      'error',
      `MessagePack decode failed from ${clientIp} (${bytes.length} bytes): ${err} | head=${bytes.subarray(0, 48).toString('hex')}`
    )
    mainWindow?.webContents.send('message-error', {
      error: 'Invalid MessagePack format',
      rawMessage: message
    })
    return
  }

  try {
    if (decoded?.action !== 'input') {
      log('info', `<- ${clientIp} ${decoded?.action} id=${decoded?.id} ${(decoded as WebSocketGamepadPayload)?.gamepadType ?? ''}`)
    }

    switch (decoded?.action) {
      case 'handshake':
        await handleHandshake(ws, clientIp)
        break

      case 'register':
        await handleRegister(ws, clientIp, decoded as WebSocketGamepadPayload)
        break

      case 'input':
        await handleInput(ws, decoded as WebSocketGamepadPayload)
        break

      case 'disconnect':
        await handleDisconnect(ws, decoded as WebSocketGamepadPayload)
        break

      case 'delay_test_request_ack':
        await handleDelayTestRequestAck(decoded as WebSocketPingPayload)
        break

      default:
        logThrottled(`unknown:${clientIp}`, 'warn', `Unknown action from ${clientIp}: ${JSON.stringify(decoded)?.slice(0, 200)}`)
        const response: WebSocketMessage = {
          action: 'error',
          status: 'error',
          payload: 'Invalid action'
        }
        ws.send(encode(response))
    }
  } catch (err) {
    log('error', `Failed to handle '${decoded?.action}' from ${clientIp}: ${err}`)
  }

  async function handleHandshake(ws: WebSocket, clientIp: string): Promise<void> {
    if (connections.size >= getMaxConnections()) {
      const response: WebSocketMessage = {
        action: 'handshake_ack',
        status: 'error',
        payload: 'E_MAX_CONN'
      }
      log('warn', `Rejected ${clientIp}: max connections (${connections.size}/${getMaxConnections()})`)

      ws.send(encode(response))
      ws.close()
      return;
    }

    const response: WebSocketMessage = {
      action: 'handshake_ack',
      status: 'ok',
      payload: 'ok'
    }
    ws.send(encode(response))
  }

  async function handleDisconnect(_: WebSocket, payload: WebSocketGamepadPayload): Promise<void> {
    const { id } = payload
    clientMap.delete(id as number)
    clearThrottle(`client:${id}:`)

    releaseGamepad(id as number)

    mainWindow?.webContents.send('gamepad:disconnected', { id })
  }

  async function handleRegister(
    ws: WebSocket,
    clientIp: string,
    payload: WebSocketGamepadPayload
  ): Promise<void> {
    let clientId: number
    try {
      clientId = await createGamepad(payload.gamepadType as GamepadType)
    } catch (err) {
      log('error', `Gamepad creation failed for ${clientIp}: ${err}`)
      const failed: WebSocketMessage = {
        action: 'register_ack',
        status: 'error',
        payload: 'E_CREATE_FAILED'
      }
      ws.send(encode(failed))
      return
    }

    const response: WebSocketMessage = {
      action: 'register_ack',
      status: 'ok',
      payload: clientId.toString()
    }

    clientMap.set(clientId, newClientData(clientIp, ws, clientId))

    ws.send(encode(response))

    // Send a delay test message to the client
    sendMessageToClient(clientId, 'delay_test_request')

    log('info', `Gamepad created: ${clientIp} -> id ${clientId} as ${payload.gamepadType}`)

    // Send gamepad:registered event to renderer
    mainWindow?.webContents.send('gamepad:registered', {
      clientId: clientId,
      gamepadType: payload.gamepadType
    })
  }

  async function handleInput(ws: WebSocket, payload: WebSocketGamepadPayload): Promise<void> {
    const { id, gamepadType, gamepadData } = payload

    let delayCounter: (() => void) | null = null
    const client = clientMap.get(id as number)
    if (client && client.isTestingDelay) {
      const startTime = Date.now()
      delayCounter = () => {
        const diff = Date.now() - startTime + client.rtt
        if (!mainWindow?.isMinimized()) {
          mainWindow?.webContents.send('gamepad:get-delay', { id, delay: diff })
        }
      }
    }

    logThrottled(
      `client:${id}:input`,
      'info',
      `Input id=${id} type=${gamepadType} registered=${clientMap.has(id as number)} data=${JSON.stringify(gamepadData)}`
    )

    // Never hand the DLL an id it didn't issue: an unknown target crashes the process.
    if (!client) {
      logThrottled(`client:${id}:unregistered`, 'warn', `Dropping input from ${clientIp} for unregistered id ${id}`)
      return
    }

    if (id === -1 || !gamepadType || !gamepadData) {
      logThrottled(`client:${id}:bad-input`, 'warn', `Input from ${clientIp} missing id, gamepadType or gamepadData`)
      const response: WebSocketMessage = {
        action: 'error',
        status: 'error',
        payload: 'Missing id, gamepadType or gamepadData'
      }
      ws.send(encode(response))

      return
    }

    if (gamepadType === GamepadType.Xbox) {
      xboxInput(id as number, gamepadData as GamepadData, delayCounter)
      if (!mainWindow?.isMinimized()) {
        mainWindow?.webContents.send('gamepad:input-xbox', { id, gamepadData })
      }
    } else if (gamepadType === GamepadType.DualShock) {
      dualShockInput(id as number, gamepadData as GamepadData, delayCounter)
      if (!mainWindow?.isMinimized()) {
        mainWindow?.webContents.send('gamepad:input-dualshock', { id, gamepadData })
      }
    } else {
      logThrottled(`client:${id}:bad-type`, 'warn', `Input id=${id} has unknown gamepadType '${gamepadType}'`)
    }
  }

  async function handleDelayTestRequestAck(ping: WebSocketPingPayload): Promise<void> {
    const { id, timestamp, payload } = ping

    clientMap.get(id as number)!.T2 = timestamp
    clientMap.get(id as number)!.T3 = Number(payload)
    clientMap.get(id as number)!.T4 = Date.now()

    const T1 = clientMap.get(id as number)!.T1
    const T2 = clientMap.get(id as number)!.T2
    const T3 = clientMap.get(id as number)!.T3
    const T4 = clientMap.get(id as number)!.T4

    const rtt = (T4 - T1 - (T3 - T2)) / 2

    clientMap.get(id as number)!.rtt = rtt
    log('info', `Client ${clientIp} (id ${id}) rtt ${rtt}ms`)
  }
}

async function sendMessageToClient(clientId: number, action: string) {
  switch (action) {
    case 'delay_test_request':
      HandleDelayTestRequest(clientId)
      break
    case 'delay_test_end':
      HandleDelayTestEnd(clientId)
      break
    default:
      console.error(`Unknown action: ${action}`)
      break
  }

  function HandleDelayTestRequest(clientId: number) {
    const now = Date.now()
    clientMap.get(clientId)!.T1 = now

    const response: WebSocketMessage = {
      action: 'delay_test_request',
      status: 'ok',
      // Send the current UTC time in milliseconds
      payload: Date.now().toString()
    }
    const ws = clientMap.get(clientId)?.websocket
    clientMap.get(clientId)!.isTestingDelay = true

    if (ws) {
      ws.send(encode(response))
    } else {
      console.error(`Client ${clientId} not found`)
    }
  }

  function HandleDelayTestEnd(clientId: number) {
    const response: WebSocketMessage = {
      action: 'delay_test_end',
      status: 'ok',
      payload: clientId.toString()
    }

    const ws = clientMap.get(clientId)?.websocket
    clientMap.get(clientId)!.isTestingDelay = false
    if (ws) {
      ws.send(encode(response))
    }
  }
}

function getClientMap(): Map<number, ClientData> {
  return clientMap;
}

export { initWebSocketManager, getClientMap }
