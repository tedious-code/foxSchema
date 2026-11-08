# Homebrew formula for Fox Schema CLI (browser launcher).
# Same repo as the app — no separate tap repository.
#
#   brew tap tedious-code/foxschema https://github.com/tedious-code/foxschema
#   brew trust tedious-code/foxschema   # Homebrew 6+ (third-party taps)
#   brew install foxschema
#
# Installs the published npm package under Homebrew's prefix so Arm and Intel
# Macs get the correct Node native addons. ibm_db is an optionalDependency.
# Docker: 5nickels/foxschema:latest (linux/amd64, includes Db2).

class Foxschema < Formula
  desc "Fox Schema — schema diff, migrations, and SQL Editor (local web UI)"
  homepage "https://foxschema.com"
  url "https://registry.npmjs.org/foxschema/-/foxschema-0.3.1.tgz"
  # shasum -a 256 of the npm tarball; refreshed by packaging/homebrew/update-formula.sh
  sha256 "36b34a8e331e6ad94ded43269aa603f4c21f3eb7e9ca86a24ea5c5df9029dfbb"
  license "Apache-2.0"

  depends_on "node@22"

  def install
    system "npm", "install", "-ddd", "--global", "--build-from-source",
           "--prefix=#{libexec}", "foxschema@#{version}"
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Fox Schema opens a local web UI (Schema Sync + SQL Editor).

        foxschema

      Demo GIFs: https://github.com/tedious-code/foxschema/tree/main/docs/demo
      Docker (linux/amd64, includes Db2): docker pull 5nickels/foxschema:latest
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/foxschema --version")
  end
end
