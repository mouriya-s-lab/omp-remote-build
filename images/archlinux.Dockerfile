FROM archlinux:latest
RUN pacman-key --init && pacman-key --populate archlinux \
 && pacman -Syu --noconfirm --needed base-devel git sudo \
 && pacman -Scc --noconfirm
RUN useradd -m -s /bin/bash builder \
 && printf 'builder ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/builder \
 && chmod 0440 /etc/sudoers.d/builder
USER builder
# paru from source: the AUR paru-bin binary links an older libalpm soname than current pacman ships.
# -r removes the Rust toolchain installed as a make dependency.
RUN git clone --depth 1 https://aur.archlinux.org/paru.git /tmp/paru \
 && cd /tmp/paru && makepkg -sir --noconfirm \
 && rm -rf /tmp/paru \
 && sudo pacman -Scc --noconfirm \
 && paru --version
USER root
WORKDIR /
