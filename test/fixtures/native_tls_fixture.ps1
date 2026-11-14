$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.Security;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading.Tasks;

public static class NativeTlsFixture {
  public static void Run() {
    using (var rsa = RSA.Create(2048)) {
      var request = new CertificateRequest("CN=localhost", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
      using (var cert = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(1))) {
      using (var serverCert = new X509Certificate2(cert.Export(X509ContentType.Pfx), "", X509KeyStorageFlags.UserKeySet)) {
        // Ephemeral self-signed leaf. Nothing is installed in a trust store.
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        Console.WriteLine("READY");
        Console.ReadLine();
        string seen = "";
        var server = Task.Run(() => {
          using (var tcp = listener.AcceptTcpClient())
          using (var tls = new SslStream(tcp.GetStream(), false)) {
            tls.AuthenticateAsServer(serverCert, false, SslProtocols.Tls12, false);
            var buffer = new byte[65536];
            while (true) {
              int n = tls.Read(buffer, 0, buffer.Length);
              if (n == 0) break;
              seen += Encoding.ASCII.GetString(buffer, 0, n);
              if (seen.Contains("\r\n\r\n") && seen.EndsWith("}")) break;
            }
            var reply = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{\"reply\":\"yes\"}");
            tls.Write(reply, 0, reply.Length);
          }
        });
        using (var tcp = new TcpClient()) {
          tcp.Connect(IPAddress.Loopback, port);
          using (var tls = new SslStream(tcp.GetStream(), false, (sender, certificate, chain, errors) => true)) {
            // Test-only callback, confined to this ephemeral loopback socket.
            tls.AuthenticateAsClient("localhost", null, SslProtocols.Tls12, false);
            var body = "{\"value\":\"old\"}";
            var wire = Encoding.ASCII.GetBytes("POST /fixture/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer fixture-only-secret\r\nContent-Type: application/json\r\nContent-Length: " + body.Length + "\r\n\r\n" + body);
            tls.Write(wire, 0, wire.Length);
            var buffer = new byte[65536];
            string received = "";
            int n;
            while ((n = tls.Read(buffer, 0, buffer.Length)) > 0) received += Encoding.ASCII.GetString(buffer, 0, n);
            if (!received.Contains("{\"reply\":\"yes\"}")) throw new Exception("Wrong response");
          }
        }
        server.Wait();
        listener.Stop();
        Console.WriteLine(seen.Contains("{\"value\":\"new\"}") ? "MODIFIED" : "ORIGINAL");
      }
      }
    }
  }
}
'@
[NativeTlsFixture]::Run()
